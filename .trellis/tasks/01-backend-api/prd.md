# 建立後端資料模型與 API（活動、報名）

## Goal
提供整個 App 的資料基礎：活動、報名、使用者的資料模型與一個可讀寫的資料層。

## Requirements
- 定義 `Event`（標題、描述、地點、開始時間、名額）
- 定義 `Registration`（userId、eventId、建立時間）
- 定義 `AppUser`（id、姓名、email）
- 建立 `MockStore`：種子活動 + 查詢/新增/移除報名 + 名額計算

## Acceptance Criteria
- [x] 三個資料模型完成
- [x] MockStore 提供活動查詢、報名增刪、名額計算
- [x] 啟動時有種子活動，列表不為空

## Out of Scope
- 串接真正的 Firebase（之後再替換 MockStore）

## Technical Notes
- 影響檔案：`lib/models/*.dart`、`lib/data/mock_store.dart`
- 這是其他所有功能的前置依賴。
