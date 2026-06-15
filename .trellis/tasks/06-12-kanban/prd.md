# Kanban 小卡片只顯示標題

## Goal
在 Kanban 看板中，任務小卡片只顯示標題，移除任務描述 (description snippet)。

## Scope
- 檔案：`lib/views/tasks/tasks_board_page.dart`
- 移除 `_CardBody` widget 中的 description 區塊（約第 490–502 行）
- 保留標題、底部 row（依賴指標、負責人 chip）等其他元素

## Out of Scope
- 不修改 task detail page 的描述顯示
- 不改變卡片其他樣式或佈局

## Acceptance Criteria
- Kanban 卡片只顯示標題，不顯示 description
- 亮色 / 暗色模式皆正常顯示
