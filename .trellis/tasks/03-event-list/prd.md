# 開發活動列表與詳情頁

## Goal
讓學生可以瀏覽所有校園活動，並查看單一活動的細節。

## Requirements
- `EventListPage`：列出所有活動，顯示地點與剩餘名額，可點擊
- `EventDetailPage`：顯示活動描述、時間、地點、名額

## Acceptance Criteria
- [x] 列表顯示種子活動
- [x] 點擊進入詳情頁
- [x] 詳情頁顯示完整資訊與剩餘名額

## Out of Scope
- 報名按鈕的行為（屬於「報名功能」任務）

## Technical Notes
- 影響檔案：`lib/views/events/event_list_page.dart`、`event_detail_page.dart`
- 依賴：後端資料模型與 API（backend-api）。
