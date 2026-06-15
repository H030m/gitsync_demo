# assignTaskFlow — 動態任務分派 AI flow

## Goal

實作 `functions/src/flows/assignTaskFlow`：給定 `{repoId, taskId}`，用 OpenAI
function-calling agentic loop，根據**負載 / 專長 / 近期活動 / 下游依賴**挑出最適合
的 member，回 `{assigneeId, reasoning}`。對應 prototype 核心功能 02、ARCHITECTURE §5.2。
目前 flow body 是 stub（`throw new Error('assignTaskFlow not implemented yet')`）。

## What I already know（repo inspection 2026-06-02）

Scaffold 已約 80% 完成，只缺 flow body：

* `functions/src/handlers/assignTask.ts` — ✅ `onCall`，auth guard、validate
  `{repoId, taskId}`、`secrets:[openaiKey]`、`timeoutSeconds:120`，直接 `return assignTaskFlow(...)`。
* `functions/src/flows/assignTask.ts` — ❌ stub。已定義 `AssignTaskInput` / `AssignTaskResult`。
* `functions/src/prompts/assignTask.ts` — ✅ `assignTaskSystem`，已描述 4 個 tool 與規則。
* `functions/src/types.ts` — ✅ `AssignmentDecisionSchema = z.object({ assigneeId, reasoning })`。
* `functions/src/config.ts` — ✅ `getOpenAI()`、`MODELS.reasoning='gpt-4o'`、`openaiKey`。
* 前端：`functions_service.dart` LIVE `assignTask` callable 已接，回 `(assigneeId, reasoning)`；
  另有**獨立的 `TasksBoardVm.assignTo(taskId, assigneeId)` → `task_repo.assignTo`** 寫入路徑。
  `FakeFunctionsService.assignTask` 回 canned 結果。

### 資料分布（重要 — readTeamState 要 join）

* `apps/gitsync/repos/{repoId}/members/{userId}` — `role, activeIssueCount,
  completedTaskCount, lastActiveAt`（**只有負載，沒有身份/專長**）。
* `apps/gitsync/users/{userId}` — `name, githubLogin, discordUserId, expertiseTags`（身份 + 專長）。
* `expertiseTags` 註記為「自動學習」→ MVP 階段可能多為空，設計要能容忍。
* commits：`messageEmbedding`(1536 Vector)、`author.{login,name,email}`、`linkedTaskIds`、
  `repoId`（冗餘，供 findNearest 預過濾）。

### Design contract（ARCHITECTURE §5.2）

4 tools：`readTeamState(repoId)` / `searchMemberCommits(memberId, query)` /
`getTaskDependents(repoId, taskId)` / `finalizeAssignment(assigneeId, reason)`。
Agentic loop max 5 round，`tool_choice:'auto'`，agent 自行決定要不要做 vector search /
查依賴；`finalizeAssignment` 被呼叫即結束。**用 `chat.completions.create` + tools**
（非 breakdown 的 `.beta.parse`）。

### 可重用 helper

* `tools/embedding.ts` → `embed(text)`（searchMemberCommits 的 query 向量化）。
* `findNearest` 預過濾慣例（`.where('repoId','==',repoId)`，見 database-guidelines 向量章）。
* counter 用 `FieldValue.increment`（Rule A）；跨 doc 用 `runTransaction`（Rule B）。

## Decisions

* **[Q1 → auto-apply]** `finalizeAssignment` 直接把 `assigneeId` 寫進 `tasks/{taskId}.assigneeId`
  並更新負載 counter：在一個 `runTransaction` 內 — 新 assignee `activeIssueCount +1`；
  若該 task 原本已有 assignee 且不同人 → 舊 assignee `activeIssueCount -1`（reassign）；
  同人則不動。flow 仍回 `{assigneeId, reasoning}` 給前端顯示。

* **[Q2 → 含 4 tool]** MVP 註冊全部 4 個 tool，含 `searchMemberCommits`。
  需 `memberId(userId) → githubLogin`（讀 users doc）→ `findNearest` on commits
  `where repoId==repoId AND author.login==githubLogin`，query 向量 = `embed(query)`。
  **需要 commits 的向量複合索引（使用者自行部署）**；實作時補進 `firestore.indexes.json`
  並給使用者部署指令。

* **[Q3 → 邊界]**
  * 無 member → `throw HttpsError('failed-precondition', '沒有可分派的成員')`。
  * 單一 member → 跳過 OpenAI，直接分派給他 + 寫入 + counter（省一次模型呼叫）。
  * 跑滿 5 round 沒 `finalizeAssignment` → fallback 挑 `activeIssueCount` 最低者分派。
  * 目標 task 狀態已 `done` → `throw HttpsError('failed-precondition', '任務已完成，無法分派')`。

## Requirements (final)

* **Pre-checks**（呼叫 OpenAI 前）：讀目標 task；若 `status==='done'` → 丟錯。
  讀 members；若 0 人 → 丟錯；若剛好 1 人 → 跳過 AI 直接分派該人。
* **Agentic loop**（≥2 人）：`chat.completions.create({ model:MODELS.reasoning,
  messages, tools, tool_choice:'auto' })`，max 5 round，平行執行 tool_calls，
  把 `{role:'tool', tool_call_id, content}` 塞回 messages。
* **4 tools**：
  * `readTeamState(repoId)` → 每位 member join users doc：`{userId, name, githubLogin,
    discordUserId, activeIssueCount, expertiseTags, lastActiveAt}`。
  * `searchMemberCommits(memberId, query)` → userId→githubLogin→`findNearest` on
    commits（`where repoId==repoId AND author.login==githubLogin`），query=`embed(query)`。
  * `getTaskDependents(repoId, taskId)` → `tasks where dependsOn array-contains taskId`。
  * `finalizeAssignment(assigneeId, reason)` → 結束 loop。
* **finalizeAssignment 副作用（auto-apply）**：`runTransaction` 內寫
  `tasks/{taskId}.assigneeId = assigneeId`，新人 `activeIssueCount +1`；
  若原 assignee 不同 → 舊人 `-1`（用 `FieldValue.increment`，Rule A/B）。
* **Fallback**：loop 跑滿 5 round 未 finalize → 挑 `activeIssueCount` 最低者，走同一寫入路徑。
* flow 回 `{assigneeId, reasoning}` 給前端顯示。

## Acceptance Criteria (final)

* [ ] `assignTaskFlow({repoId, taskId})` 回合法 `{assigneeId, reasoning}`，assigneeId ∈ 該 repo members，
  且 `tasks/{taskId}.assigneeId` 與 counter 已被正確更新。
* [ ] reassign（task 原本指派給別人）→ 舊 assignee counter −1、新 assignee +1。
* [ ] 單元測試（boundary-mock OpenAI + Firestore）涵蓋：正常 agentic 分派、單一 member 捷徑、
  無 member 丟錯、task 已 done 丟錯、跑滿 round fallback、reassign counter 收支。
* [ ] `firestore.indexes.json` 補上 searchMemberCommits 所需的 commits 向量索引 + 給部署指令。
* [ ] lint / typecheck / 既有測試全綠。

## Definition of Done

* Tests added；lint / typecheck / jest green。
* 若行為影響 schema/spec → 更新 `.trellis/spec/`。

## Out of Scope

* `generateHandoffFlow` / `summarizeDayFlow`（之後的 task）。
* expertiseTags 的自動學習機制（這裡只「讀」，不負責「產生」）。
* 前端分派 UI 的改動（Q1 選 auto-apply，flow 直接寫入；前端維持顯示 reasoning 即可）。

## Future / TODO（之後再做，本 task 不含）

* **整合 Discord 聊天紀錄當分派依據**（user 指定 2026-06-02）：之後新增一個
  `searchDiscordMessages(repoId, query)` tool（Firestore vector search on
  `discordMessages`），讓 assign agent 也能參考「誰在 Discord 討論過相關主題」。
  `readTeamState` 已回三組身份對照（userId / githubLogin / **discordUserId**），
  就是為了把 `discordMessages.authorId`(snowflake) 對齊回 member —— 這個擴充點現在
  先保留，等 Discord ingestion（`discordMessageIngest`）做完、`discordMessages` 有資料
  後再加。設計上與 §5.3 handoff flow 的 `searchDiscordMessages` 共用同一條 RAG。

## Technical Notes

* SDK function-calling path：`openai.chat.completions.create({ model, messages, tools, tool_choice:'auto' })`，
  讀 `choice.message.tool_calls`，平行執行後把 `{role:'tool', tool_call_id, content}` 塞回 messages。
* timeoutSeconds 已設 120；max 5 round 配合避免逼近上限。
