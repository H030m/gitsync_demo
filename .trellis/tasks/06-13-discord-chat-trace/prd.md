# discordChat 接 agent live trace

## Goal

讓 discord 問答（`discordChatFlow`）在跑工具迴圈時，把每一步思考過程即時串到前端，
與 askRepo / handoff 一致地顯示「Listing day summaries… / Reading a day's digest… /
Searching Discord… / Composing answer…」。對應 demo 6/18。

## Background（現況 inspection 2026-06-13）

- `discordChatFlow`（`flows/discordChat.ts`）已是 `chat.completions.create` + `tools` +
  `tool_choice:'auto'` 的迴圈（MAX_ROUNDS=4），工具：`listDaySummaries`/`getDaySummary`/
  `searchDiscordMessages`，每輪把 tool 結果餵回。**完全沒有 trace 寫入**。
- handler（`handlers/discordChat.ts`）未收 `runId`、未驗證、未傳入 flow。
- 前端 discord 問答畫面（discord chat tab/sheet）目前送出後僅有一般 loading，無 live steps。

## Requirements

### 1. flow 接 trace
- `DiscordChatInput` 新增可選 `runId`。
- 進迴圈前 `startRun(repoId, runId, 'discordChat')`；每輪執行完 tool calls 後，
  `appendStep(repoId, runId, calls.map(toLabel))`（用 #1 的 `TRACE_LABELS`）。
- 模型不再呼叫工具、要產出答案前，補一筆 `appendStep(…, TRACE_LABELS.composing)`。
- 迴圈結束（正常或 round-limit forced answer）`finishRun(repoId, runId, 'done')`；
  例外路徑 best-effort `finishRun(…, 'error')`。
- 全程 best-effort：trace 失敗永不影響答案。

### 2. handler 收 runId
- `handlers/discordChat.ts` 從 request.data 取 `runId`，沿用 generateHandoff 的
  `/^[A-Za-z0-9_-]{1,200}$/` 驗證，傳入 flow。

### 3. 前端顯示（與 #5 協調，但本 task 負責 discord 問答畫面）
- discord 問答 ViewModel 生成 `discordchat-` 前綴 runId、訂閱 `AgentRunRepository.watch`、
  sending 期間餵 `AskRepoLiveTraceStrip`，完成 finally 清空並 cancel 訂閱（鏡像 ask_repo_vm）。

## Acceptance Criteria
- [ ] discord 問答送出後，畫面即時顯示工具步驟（含 Searching Discord… / Composing answer…）。
- [ ] 無 runId（或舊 client）時行為 byte-identical，答案/snippets 不變。
- [ ] handler 對非法 runId 回 invalid-argument。
- [ ] `functions` jest（含 discordChat 既有測試）+ typecheck 綠燈；Flutter analyze + vm 測試綠燈。
- [ ] 亮 / 暗色模式皆正常。

## Out of Scope
- 改變 discordChat 的工具集或檢索行為（它已會檢索；功能升級不在此）。
- 背景 `discordDailyDigest` 的 trace（無觀眾，不做）。

## Technical Notes
- 每輪一次批次 `appendStep`（沿用 handoff 的 write cadence），降低 Firestore 寫入次數。
- `composing` step 只在「該輪無 tool call、準備輸出答案」時補，避免最後一輪重複。
