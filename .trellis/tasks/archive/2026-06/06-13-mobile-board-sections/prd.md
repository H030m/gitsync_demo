# Tasks 看板手機版重設計：三段收合式清單

## Goal

現有 kanban 在手機上是三條 200dp 欄位橫向捲動，左右太窄、操作不舒服。
窄螢幕改成 TickTick 風格的**垂直收合式清單**（參考圖 picture1/picture2）：
待辦 / 進行中 / 完成 三個 section header，點擊展開/收合；展開後是簡潔的任務列；
點任務列進入既有的 TaskDetailsPage（該頁不變）。寬螢幕維持現有三欄 kanban。

## Requirements（已收斂）

1. **只換窄螢幕分支**：`_BoardTab` 的 `fill == false` 分支改為垂直收合清單；
   寬螢幕（fill mode）三欄 kanban 與長按拖拉完全不動。
2. **三個 section**：待辦 / 進行中 / 完成。header 顯示「狀態名 + 數量 badge」，
   沿用 `_ColumnTheme` 的 per-status 色票（ColorScheme 推導，亮/暗皆正確）。
3. **展開/收合**：點 header toggle；附展開/收合動畫（AnimatedSize / ExpansionTile 系）。
   預設：待辦+進行中展開、完成收合。狀態不持久化（離開回來回到預設）。
4. **任務列**：簡潔一列 = 左側圓圈 + 標題 + 右側負責人頭像（沿用 `_AssigneeCircle`）。
   點列 → `NavigationService.goTaskDetails`（與現行卡片一致）。
5. **圓圈勾選 = 標記完成**：點列左側圓圈直接 `updateStatus(id, done)`（任何狀態→完成）；
   已完成 section 的列顯示實心/打勾圓圈，點擊不再有動作（或顯示已完成態）。
   其他狀態變更一律走詳情頁。錯誤時 SnackBar（沿用 `updateStatusFailed` 字串模式）。
6. **空 section**：展開後若無任務顯示「—」或輕量空狀態（與現行欄位空狀態一致）。
7. 新字串走 l10n（en + zh-Hant）；無新依賴。

## Acceptance Criteria

* [ ] 手機寬度（< fill 門檻）不再出現橫向捲動 kanban，改為垂直收合清單
* [ ] 三個 section 可獨立展開/收合，預設 待辦+進行中 開、完成 收
* [ ] 點任務列 → TaskDetailsPage；點圓圈 → 任務變完成（含錯誤 SnackBar）
* [ ] 寬螢幕三欄 kanban 行為與外觀不變（既有 fill-mode 測試持續通過）
* [ ] 亮/暗模式皆正確（無 hardcode 顏色）
* [ ] `flutter analyze` 0 error/0 warning；`flutter test` 全綠——
      **含收掉 temmie 06-12 遺留的 2 個紅測試**（舊窄版測試重寫為新清單測試）

## Definition of Done

* Widget tests：新清單的渲染/展開收合/點列導頁/圓圈完成（取代壞掉的舊測試）
* 模擬器親測亮/暗模式
* Journal + _index 更新

## Decision (ADR-lite)

**Context**: kanban 三欄在手機橫向捲動體驗差；demo 主場景是手機。
**Decision**: 響應式雙佈局——窄=TickTick 收合清單（圓圈勾完成）、寬=既有 kanban 不動；
預設 待辦+進行中 展開。
**Consequences**: 手機失去拖拉換任意狀態（改走詳情頁），換得單手可用的清單；
「勾完成」直達 demo 的核心鏈路（done → AI 分派 → FCM 推播）；寬螢幕零風險。

## Out of Scope (explicit)

* TaskDetailsPage、Graph tab、AddTodo 流程
* 後端 / `TasksBoardViewModel` 資料層（純 View 層；updateStatus 既有方法夠用）
* 收合狀態持久化（SharedPreferences）——之後有需要再說

## Technical Notes

* 主要檔案：`lib/views/tasks/tasks_board_page.dart`（窄分支重寫）、
  `lib/l10n/app_strings.dart`（新字串）、`test/tasks_board_test.dart`（重寫窄版測試）
* `_ColumnTheme` / `_AssigneeCircle` / `_CountChip` 可重用
* 既有紅測試：`card renders its description snippet`、`deps + handoff indicators`——
  測的是 06-12 已被刻意移除的 UI，隨本次窄版重寫一併刪除/重寫
* fill 門檻常數 `_kMinColumnWidth/_kColumnGap/_kBoardHPad` 維持，僅替換 narrow 分支內容
