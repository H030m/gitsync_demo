# Kanban Column 縮窄

## Goal
將 Kanban 看板的三欄最小寬度從 240dp 縮減為 200dp，配合卡片移除 description 後的精簡內容。

## Requirements
- `_kMinColumnWidth` 從 240 改為 200
- 桌面模式 fillThreshold 自動跟著調整（已用常數計算）
- 手機模式固定寬度也跟著縮窄

## Acceptance Criteria
- [ ] `_kMinColumnWidth = 200`
- [ ] 亮色 / 暗色模式皆正常顯示
- [ ] 桌面模式三欄仍能正確填滿
- [ ] 手機模式水平滾動正常

## Out of Scope
- 不改變欄間距或 padding
- 不改變卡片內部樣式

## Technical Notes
- 檔案：`lib/views/tasks/tasks_board_page.dart:21`
- `fillThreshold` 在第 118-119 行用 `_kMinColumnWidth` 計算，改常數即可連動
