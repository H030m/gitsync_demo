# 任務狀態編輯：詳情頁 chip 可點 + 清單列長按選單

## Goal

06-13-mobile-board-sections 把手機看板改成收合清單後，手機上唯一的狀態轉移只剩
圓圈「→完成」；調查發現 TaskDetailsPage 的狀態其實是**唯讀 chip**，從來沒有編輯功能
（先前靠寬螢幕拖拉掩蓋了這個缺口）。本 task 補齊任意狀態轉移，雙入口（使用者選定方案 3）。

## Requirements（已決定，不再 brainstorm）

1. **詳情頁狀態編輯**：`_StatusChip`（task 本體那顆，`task_details_page.dart:292`）變可點，
   點擊開三狀態選擇（menu / bottom sheet，三項都列、當前狀態標示），選擇後 updateStatus；
   錯誤跳 SnackBar。相關任務列表（subtask/dependency）上的唯讀 chip 不變。
2. **清單列長按選單**：手機收合清單（`_SectionTaskRow`）長按 → 同樣的三狀態選擇。
   既有的圓圈「→完成」與點列導頁行為不變。
3. 視覺：選單項目沿用 per-status 色票（`_StatusChip` / `_ColumnTheme` 的 switch 模式）；
   亮/暗皆正確。
4. 新字串走 l10n（en + zh-Hant）；無新依賴。

## Acceptance Criteria

* [ ] 詳情頁點狀態 chip → 可切換到任一狀態，UI 即時反映（stream 驅動）
* [ ] 手機清單長按任務列 → 可切換到任一狀態，任務移到對應 section
* [ ] 圓圈「→完成」與點列導頁行為不變；寬螢幕 kanban 拖拉不變
* [ ] 錯誤時 SnackBar（沿用 updateStatusFailed 模式）
* [ ] analyze 0 err/0 warn；test 全綠（新增兩個入口的 widget tests）

## Out of Scope

* 狀態以外的欄位編輯（title/description 等）
* 收合清單其他行為

## Technical Notes

* 分支：沿用 `feature/mobile-board-sections`（同一個未開 PR 的功能線，一起 review）
* 詳情頁用哪個 VM 做 updateStatus 由實作時確認（TasksBoardViewModel.updateStatus 已存在）
* 三狀態選擇 UI 建議共用一個 helper（兩入口同款），放 views/tasks/ 下
