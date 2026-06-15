# 建立「我的報名」管理頁

## Goal
讓學生集中查看自己報名了哪些活動，並能在此快速取消。

## Requirements
- `MyRegistrationsPage`：列出目前使用者已報名的活動
- 每筆可快速取消、點擊可回到活動詳情
- 未登入時提示先登入；無報名時顯示空狀態

## Acceptance Criteria
- [x] 顯示已報名活動清單
- [x] 可在清單直接取消
- [x] 未登入 / 無報名有對應提示

## Out of Scope
- 報名邏輯本身（屬於報名功能任務）

## Technical Notes
- 影響檔案：`lib/views/registrations/my_registrations_page.dart`
- 依賴：報名功能（registration）。
