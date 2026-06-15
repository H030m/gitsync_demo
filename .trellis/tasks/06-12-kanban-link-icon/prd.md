# Kanban 卡片移除依賴 link icon

## Goal
移除 Kanban 小卡片底部的依賴 link icon（`Icons.link` + 數字），簡化卡片視覺。

## Requirements
- 移除 `_CardBody` 中 `task.dependsOn.isNotEmpty` 條件區塊（link icon + 依賴數量文字 + spacing）
- 保留 handoff doc icon、Spacer、AssigneeCircle 等其他底部元素

## Acceptance Criteria
- [ ] 卡片底部不再顯示 link icon 和依賴數量
- [ ] 亮色 / 暗色模式皆正常
- [ ] 底部 row 其餘元素（handoff icon、負責人 chip）不受影響

## Out of Scope
- 不修改 task detail page 的依賴顯示
- 不改變其他卡片樣式

## Technical Notes
- 檔案：`lib/views/tasks/tasks_board_page.dart` 約第 494–503 行
