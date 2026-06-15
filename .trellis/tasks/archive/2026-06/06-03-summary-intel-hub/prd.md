# Summary Intelligence Hub — 開發者每日情報總站

> Task: `06-03-summary-intel-hub` · Owner: gitsync · Branch: `feature/summary-intel-hub`

## 1. 背景與目標

`Daily → Summary` tab 目前只是一張「日報文字 + Regenerate 按鈕」的空殼，後端
`summarizeDayFlow` 仍是 `throw new Error('not implemented yet')`。`scheduledDailyReport`
的 Cloud Tasks 扇出也是 TODO。

本任務把整個 **summary** 區塊做完，並把它升級成一個 **開發者每日情報總站
(Developer Daily Intelligence Hub)**：把當天的 commits、完成的 tasks、Discord 討論
彙整成「人話日報 + 重點 + 阻礙 + commit 主題整理 + 成員貢獻」，並提供一個
**agentic「問 AI 今天發生什麼」聊天框**，讓開發者自然語言追問。

對應文件：[`ARCHITECTURE.md §5.4`](../../docs/ARCHITECTURE.md)、
[`AGENTIC_CONCEPTS.md`](../../docs/AGENTIC_CONCEPTS.md)（把 summarizeDay 從「非 Agentic 單次」
升級為 full agentic function-calling loop）。

## 2. 範圍 (Scope) — 只動 summary

### 後端 functions/
1. **`summarizeDayFlow` (agentic)** — function-calling loop，工具
   `listDayCommits` / `listCompletedTasks` / `getDiscordDigest` /
   `searchPastCommits`，最後 `finalizeReport` 產出 structured 結果，寫
   `dailyReports/{date}`。
2. **`dailyBriefChatFlow` + `dailyBrief` callable (agentic 情報總站聊天)** — 仿
   `discordChatFlow`，agent 用同一組唯讀工具回答關於「今天/某天」的問題。
3. **schema 擴充** — `DailyReportSchema`：`summary` + `highlights[]` +
   `blockers[]` + `commitThemes[]`(commit 訊息整理) + `memberContributions`。
4. **`scheduledDailyReport`** — 補完 Cloud Tasks 扇出 enqueue。
5. 對應 **tools** 抽到 `functions/src/tools/dailyIntel.ts`（純函式，可測、fake 友善）。

### 前端 lib/
1. `DailyReport` model 擴充 highlights / blockers / commitThemes。
2. `_SummaryTab` 重build：日報卡（summary + highlights + blockers）、commit 主題
   整理區、成員貢獻 chips、**「問 AI 今天」聊天框**。
3. 新 `DailyBriefChatViewModel` + `functions_service.dailyBrief` + fake 實作。
4. `dummy_data.todayReport` 補上新欄位 + fake brief 聊天。
5. router providers 接線。

### 測試 / 驗收 gate
- `npm --prefix functions run typecheck` 0 error
- `npm --prefix functions test`（新增 summarizeDay / dailyBrief / scheduledDailyReport 測試）全綠
- `flutter analyze` 0 issue
- fake 模式 Summary tab 三部分（日報卡 / commit 整理 / 問 AI）端到端可操作

## 3. 非目標
- 不動 Discord / Tasks / Stats / Repo 其它模組（除共用 service interface 必要新增方法）。
- 不做 `firebase deploy`（沿用既有部署慣例，留給人工）。
- Discord/commit 仍走既有關鍵字檢索（commit 已有 embedding，past-commit 工具用既有 vector helper 若可，否則降級關鍵字）。

## 4. 風險
- structured output 需相容既有 `DailySummarySchema`（已被 Flutter model 部分使用）→ 擴充而非破壞。
- agentic loop 要有 round 上限 + best-effort 降級（沿用 discordChat 模式）。
- 寫 `dailyReports/{date}` 受 Firestore rules `allow write: if false` 保護 → 只由 Cloud Functions(admin) 寫，前端唯讀（已符合）。
