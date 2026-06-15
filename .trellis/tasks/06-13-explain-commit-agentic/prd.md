# explainCommit 改 agentic + 撈關聯 Discord + live trace

## Goal

把「點 commit → AI 解釋這次工作」從單次呼叫升級成 agentic 工具迴圈：讓 agent 依 commit
內容自行決定去 **搜尋相關的 Discord 討論**、撈鄰近 commit、看 diff，再寫出解釋；過程即時
串 trace 到前端。對應 demo 6/18。

## Background（現況 inspection 2026-06-13）

- `explainCommitFlow`（`flows/explainCommit.ts`）目前是**單次** `chat.completions.create`：
  事前用寫死步驟撈「同作者最近 10 筆 commit（neighbors）」+ 連結的 task，餵進 prompt。
  **不呼叫任何工具、不碰 Discord、無 trace。**
- 有快取（commit doc 的 `workSummary`，`force` 才重算）與 06-05 D2 的 GitHub fallback
  （無 doc 時用 GitHub API，且不寫快取）。
- 工具可復用：`searchDiscordMessages`（`tools/discordSearch.ts`）、`getCommitDiff`/
  `listRelatedCommits`（`tools/handoffTools.ts`）。neighbor 查詢邏輯目前 inline。

## Requirements

### 1. flow → 工具迴圈
- 以 generateHandoff 的兩相位精神改寫（單相位即可）：seed context = 此 commit 的
  message/files/aiSummary/linkedTasks；agent 在迴圈中可呼叫：
  - `searchDiscordMessages(query)` — 找與此 commit 相關的團隊討論（**新檢索能力**）。
  - `listNeighborCommits()` — 同作者鄰近 commit（把現有 inline 邏輯包成工具）。
  - `getCommitDiff(sha)` — 需要時看 patch（cost guard，sparingly）。
  - `writeExplanation(markdown)` — 收尾，結束迴圈。
- 全域 caps：`MAX_ROUNDS`（例 4）、`MAX_TOOL_CALLS`，到頂以 `tool_choice` 強制 writeExplanation，
  保證收斂。
- 維持四段式/簡短 markdown 風格（沿用 `explainCommitSystemPrompt`，補上「可引用 Discord
  討論、註明出處」指引）。

### 2. trace
- `ExplainCommitInput` 加可選 `runId`；`startRun(…, 'explainCommit')` → 每輪 `appendStep`
  （TRACE_LABELS）→ `finishRun`。best-effort。

### 3. 快取 / fallback 不退化
- 快取命中（有 `workSummary` 且非 force）仍**零 OpenAI 呼叫**直接回傳。
- GitHub fallback 路徑（無 doc）維持可運作；該路徑工具集縮減（無 linkedTasks/neighbors，
  但仍可 searchDiscordMessages），且不寫快取。
- 重算成功才寫回 `workSummary` + `workSummaryGeneratedAt`（best-effort）。

### 4. handler
- `handlers/explainCommit.ts` 取並驗證 `runId`，傳入 flow。

## Acceptance Criteria
- [ ] 點 commit 時前端即時顯示思考步驟（含 Searching Discord… / Listing nearby commits… /
      Writing the explanation…）。
- [ ] 解釋內容會在有相關討論時引用 Discord（無相關討論時不硬湊、不報錯）。
- [ ] 快取命中仍不呼叫 OpenAI；GitHub fallback 仍可產出解釋。
- [ ] 無 runId / 舊 client 行為相容；handler 對非法 runId 回 invalid-argument。
- [ ] `functions` jest（含 explainCommit 既有測試，必要時更新）+ typecheck 綠燈；
      Flutter analyze 綠燈。

## Out of Scope
- 背景 commit enrichment（`onCommitCreated` 的 aiSummary/embedding）不變。
- 前端 commit 解釋畫面的 strip 接線細節由 #5 統籌（本 task 提供 flow/handler 介面）。

## Technical Notes
- `listNeighborCommits` 把現有 `author.login` + `committedAt desc` 查詢包成工具，
  保持 best-effort（查詢失敗回空陣列）。
- diff 工具沿用 `MAX_PATCH_CHARS` 截斷；只在 agent 指名 sha 時才打 GitHub。
- 迴圈訊息結構：每個 tool_call 都要回對應 `role:'tool'`，避免 thread 不完整。
