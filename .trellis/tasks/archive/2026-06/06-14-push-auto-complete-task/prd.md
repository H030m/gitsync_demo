# push 自動判定 task 完成並設為 done

## Goal

收到 GitHub `push` webhook 後，由 **AI agent（LLM）** 判斷該 commit 是否真的「完成」了對應的 task，若是則自動把該 task 的狀態設為 `done`。比起單純的 closing-keyword 比對，改用 agent 依 task 內容與 commit 實際變更做語意判斷。

## Branch 策略（user 指定）

* 開發 base = `develop`；實作時從 develop 開 feature branch。
* task PR target 已設為 `develop`。
* 確認沒問題後才另行 merge 回 `main`（獨立步驟，不在本 task 自動做）。

## What I already know（從程式碼確認）

* `handlePush`（`functions/src/handlers/githubWebhook.ts:55`）把每個 commit 以 `.create()` 寫入 `commits/{sha}`，含 `branch`、`message` 等欄位；目前**全分支** ingest（含 feature branch）。
* `onCommitCreated`（`functions/src/triggers/onCommitCreated.ts`）已 per-commit 跑：用 `parseIssueRefs(message)` 解析 `#N` → 寫 `linkedTaskIds`，再做 embedding / aiSummary。**但不會 markDone**。
* 已有現成工具：
  * `parseClosingRefs(text)` — 只比對 closing 關鍵字（`close[sd]?/fix(e[sd])?/resolve[sd]? #N`，case-insensitive），`functions/src/tools/issueRefs.ts:32`
  * `findTaskIdsByIssue(repoId, n)` 與 `markTaskDone(repoId, taskId)`（transaction + 幂等 + member 計數），`functions/src/tools/taskStatus.ts`
* `onPRMerged`（`functions/src/triggers/onPRMerged.ts`）已用上述工具：PR 合併 + closing keyword → markTaskDone。本功能是它的「commit 版」對應物。
* repo 設定文件**沒有**存 default branch；但 GitHub push payload 帶 `repository.default_branch`，webhook 已讀 `body.repository`。

## Assumptions (temporary)

* 由 AI agent 判斷 task 是否完成（語意判斷），而非 closing-keyword 規則。
* 成本護欄：只在 commit 已透過 `#N` 連到 task（`linkedTaskIds` 非空）時才呼叫 agent，不對每個 commit × task 全跑。
* 實作落點在 trigger 層（`onCommitCreated`），維持「webhook 只原始寫入、業務邏輯在 trigger」的架構原則。
* OpenAI 基礎設施沿用既有 `getOpenAI()` / `MODELS.fast` / `openaiKey`。

## Decisions（已與 user 確認）

* **D1 判斷輸入** = commit `message` + `filesChanged` 檔名 + task 的 `title`/`description`/`acceptanceCriteria`。**不**抓 diff（純 Functions 內完成，不呼叫 GitHub API）。
* **D2 護欄** = (a) agent 回傳 confidence，**只有 ≥ 門檻（暫定 0.8）才 markDone**；(b) **只限預設分支** 的 commit 才考慮自動完成。
* **D3 輸出契約** = agent 回傳結構化 JSON `{ complete: boolean, confidence: number(0..1), reason: string }`（用 OpenAI JSON mode）。決策：`complete && confidence >= THRESHOLD` → `markTaskDone`；否則不動，記 log。
* **D4 落點**（因 first-seen/idempotency 限制，見下）：**不**放在 `onCommitCreated`。改為：
  1. `handlePush` 偵測 `ref === refs/heads/{repository.default_branch}` 時，對每個 sha 做 `set({ onDefaultBranch: true, ... }, {merge:true})`（即使 `.create()` 已 ALREADY_EXISTS 也能標記到既有 doc）。
  2. 新 trigger（暫名 `onCommitCompletesTask`，`onDocumentWritten` on `commits/{sha}`）：guard 為 `after.onDefaultBranch === true && before?.onDefaultBranch !== true`；自行 `parseIssueRefs(message)` → `findTaskIdsByIssue` → 對每個未完成 task 叫 agent 判斷 → 過門檻則 `markTaskDone`。
  * trigger 自行解析 refs（不依賴 `onCommitCreated` 寫的 `linkedTaskIds`），避免兩個 trigger 的競態。

## 關鍵設計約束（first-seen × idempotency）

commit 通常首見於 feature branch → `onCommitCreated` 當下觸發一次後即被 `markIdempotent` 鎖住；合併到 main 重推時 `.create()` 被 ALREADY_EXISTS 跳過 → `onCommitCreated` **不再觸發**。因此「只限預設分支」的完成判斷必須掛在「推到預設分支」這個事件上（D4 的 `set(merge)` 標記 + 專屬 trigger），不能複用 `onCommitCreated`。

## Requirements

* commit 推到**預設分支**且訊息含 `#N`（連到某 task）時，由 agent 判斷該 task 是否完成；`complete && confidence >= 門檻` → 自動 `markTaskDone`。
* agent 判斷輸入：task `title`/`description`/`acceptanceCriteria` + commit `message` + `filesChanged`。
* 重複投遞（同一 commit / trigger 重跑）不可重複計數（沿用 `markTaskDone` 交易內幂等 + `markIdempotent`）。
* agent 呼叫失敗或低信心 → 不改狀態，記 log（best-effort，不可讓 webhook/trigger 崩潰）。

## Acceptance Criteria

* [ ] 推到預設分支、訊息含 `#N` 且 agent 判定 complete(高信心) 的 commit → 對應 `githubIssueNumber == N` 的 task 變成 `done`。
* [ ] 同一 commit 在 feature branch 上（非預設分支）→ task 狀態不變。
* [ ] agent 判定未完成 / 低信心 → task 狀態不變。
* [ ] 已是 `done` 的 task → 不重複增加 member 計數。
* [ ] agent / OpenAI 失敗 → trigger 不拋錯，task 狀態不變。

## Definition of Done

* Tests added/updated（trigger 單元測試，沿用現有 functions 測試風格）
* Lint / typecheck 綠燈
* 行為變更記錄到 spec

## Out of Scope (explicit)

* 反向：commit 把 task 從 done 退回（已有 `onIssueWritten` 處理 issue reopen）
* 修改 UI

## Technical Notes

* 對照實作：`onPRMerged.ts` 的解析→markDone 流程幾乎可直接複用。
* 若限定預設分支：需在 `handlePush` 把 `repository.default_branch` 存到 commit doc（或比對後存旗標），供 `onCommitCreated` 判斷。
