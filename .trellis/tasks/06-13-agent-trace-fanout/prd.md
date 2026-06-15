# Agent trace 共用基礎 — fanout 到 commit / discord

## Goal

把現有只服務 `askRepo` / `generateHandoff` 的 agent tool-trace side-channel
（`tools/agentTrace.ts` + Flutter `AgentRunRepository` + `AskRepoLiveTraceStrip`）
擴成可被三個前景 flow（discordChat / explainCommit / editDiscordDigest）共用的基礎，
讓「像 Claude Code 一樣顯示思考過程」的即時 trace 能接到 commit 與 discord 的 AI。對應 demo 6/18。

## Background（現況 inspection 2026-06-13）

- `agentTrace.ts` 已具備 `startRun / appendStep / finishRun`，best-effort、無 runId 即 no-op，
  並有 `AgentFlow = 'askRepo' | 'generateHandoff'` 與英文常數 `TRACE_LABELS`。
- Flutter 端 `AgentRun`/`AgentStep` model、`AgentRunRepository.watch`、`AskRepoLiveTraceStrip`
  已實作；handoff（task_details_page）剛接好，runId 以 `handoff-` 前綴生成。
- `FakeAgentRunRepository.watch` 依 runId 前綴（`handoff-`）切換 canned steps；
  其餘走 askRepo canned steps。
- 待接的三個 flow（#2/#3/#4）會用到新工具：`searchDiscordMessages`、`listNeighborCommits`、
  `getCommitDiff`、`getDaySummary`、`writeExplanation`、`writeDigest` 等，`TRACE_LABELS` 尚缺。

## Requirements

### 1. 後端 agentTrace 擴充
- `AgentFlow` union 增加 `'discordChat' | 'explainCommit' | 'editDiscordDigest'`。
- `TRACE_LABELS` 補上新工具 → 英文 label 對應（沿用「動名詞 + …」風格）：
  `listNeighborCommits`→`Listing nearby commits…`、`writeExplanation`→`Writing the explanation…`、
  `getDaySummary`→`Reading a day's digest…`、`listDaySummaries`→`Listing day summaries…`、
  `writeDigest`→`Rewriting the digest…`。`searchDiscordMessages` / `getCommitDiff` 已存在則復用。

### 2. Client runId 接線（三個 callable）
- `FunctionsService`（abstract + live + fake）的 `discordChat` / `explainCommit` /
  `editDiscordDigest` 各加可選 `String? runId`，live 端以 `'runId': ?runId` 帶入 payload。
- 對應 callable handler 已驗證 runId 格式者沿用；未驗證者由 #2/#3/#4 各自補上。

### 3. UI strip 復用
- `AskRepoLiveTraceStrip` 維持為共用 widget（已是 public）；三個畫面（#5）直接 import 復用，
  不另造。空步驟 fallback 維持 `askRepoThinking`。

### 4. Fake trace 對應
- `FakeAgentRunRepository.watch` 依 runId 前綴擴充 canned steps：
  `commit-`→explainCommit 步驟、`digest-`→editDiscordDigest 步驟、`discordchat-`→discordChat 步驟，
  並把 `flow` 欄位設成對應值。沿用 `simulatedLatency` 節奏，確保 trace 在對應 fake callable
  resolve 前播完。

## Acceptance Criteria
- [ ] `AgentFlow` union 與 `TRACE_LABELS` 覆蓋三個新 flow 的所有工具名。
- [ ] 三個 callable 的 client 簽名（abstract/live/fake/測試覆寫）皆含 `runId`，typecheck/analyze 綠燈。
- [ ] fake 模式下，三種 runId 前綴各自播出對應的 canned thinking 步驟。
- [ ] 既有 askRepo / handoff 行為 byte-identical（無 runId 時皆 no-op；既有測試不變）。
- [ ] `functions` jest + typecheck 綠燈；Flutter analyze 無新 issue。

## Out of Scope
- 三個 flow 本身的 agentic 改造（#2/#3/#4 負責）。
- 三個畫面的 ViewModel/strip 接線（#5 負責）。
- label 的 i18n（維持後端英文常數、前端逐字顯示的既有設計）。

## Technical Notes
- 嚴格沿用 best-effort 契約：trace 寫入永不影響 host flow 控制流與結果。
- runId 前綴慣例集中於此 task 定義，供 #5 client 生成時引用，避免散落 magic string。
