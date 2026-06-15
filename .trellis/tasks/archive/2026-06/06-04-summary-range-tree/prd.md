# Summary 時段日報 + Commit Tree 地圖（AI 工作總結）

> Task: `06-04-summary-range-tree` · Owner: gitsync · Branch: `feature/summary-intel-hub`（接續前一輪）

## 1. 背景

前一輪把 Summary tab 做成情報總站（agentic 日報 + 問 AI 今天），但：
1. 日報只能看「今天」一天 — 使用者要**自選時段**，抓整段範圍內所有 commits、
   completed tasks、Discord 訊息（digest 優先、raw 訊息兜底）。
2. Commits tab 仍是上一輪未動的陽春列表 — 要**時段篩選**＋**可滑動的
   commit tree 地圖**（lane-per-author 圖），**點任一 commit 由 AI 總結該筆工作內容**。

## 2. 範圍

### 後端 functions/
1. **`tools/dailyIntel.ts` 範圍化**：`taipeiRangeBounds(start,end)`、
   `listRangeCommits` / `listRangeCompletedTasks` / `listRangeDigests` /
   `listRangeDiscordMessages`（cap 500）；單日版改為範圍版的薄包裝。
2. **`summarizeDayFlow` 範圍化**：input `{repoId, startDate, endDate}`；
   doc id：單日 = `date`、範圍 = `{start}_{end}`，欄位補 `startDate`/`endDate`；
   agent 工具補 `listRangeDigests` + `listRangeDiscordMessages`。上限 92 天。
3. **`summarizeDay` callable**：相容 `{date}` 舊參數，新收 `{startDate,endDate}`。
4. **`dailyBrief`**：加 optional `endDate`，工具改範圍版。
5. **新 `explainCommit` callable + `explainCommitFlow`**：input `{repoId, sha}`；
   讀 commit doc + linked tasks + 同作者鄰近 commits → 一次 OpenAI 呼叫產
   markdown 工作總結；寫回 `commits/{sha}.workSummary`（cache，重點即回）。
6. firestore.indexes.json：tasks `status==` + `updatedAt range` 複合索引（若缺）。

### 前端 lib/
1. `CommitRepository.streamRange` + fake；dummy commits 補 staggered `committedAt`。
2. `CommitsViewModel`：range 狀態 + `setRange`/`clearRange` + `explain(sha)`
   （cache map、loading 狀態，呼叫 `explainCommit`）。
3. **Commits tab 重建**：range 按鈕 + **commit tree 地圖**（CustomPaint lane 圖、
   author 一人一 lane 一色、日期分隔、可滑動）；點 row → bottom sheet 顯示
   commit 詳情 + AI 工作總結（auto-fetch + spinner）。
4. Summary tab：range 按鈕（`showDateRangePicker`），同步 `DailyReportViewModel`
   與 `DailyBriefChatViewModel` 的範圍；report 卡顯示範圍 label。
5. `functions_service`：`summarizeDay(startDate,endDate)`、`dailyBrief(+endDate)`、
   `explainCommit`；fake 全配。

### Gate（多角色審查）
- 開發者：實作；調查員：jest + analyze + 自我 code review；使用者：widget 測試
  實際渲染 Commits tree、點擊出 AI 總結、Summary 範圍切換。
- `npm --prefix functions run typecheck/test/lint` 全綠；`flutter analyze/test` 全綠。
- 完成後 push `feature/summary-intel-hub`。

## 3. 非目標
- 真正的 git parent DAG（webhook 未存 parent shas）— lane 圖以作者鏈呈現。
- `firebase deploy`／Cloud Tasks queue 實布署。
- Discord raw 訊息 embedding。

## 4. 風險
- `summarizeDay` 簽名變更 → 全部呼叫端（VM、fake、測試）同步改。
- tasks 複合查詢需索引（live 模式）→ 補 indexes.json 並在 docs 註記。
- 範圍 commits 可能數百筆 → context cap + log。
