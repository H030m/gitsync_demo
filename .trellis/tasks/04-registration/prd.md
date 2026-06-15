# 實作報名功能（報名 / 取消）

## Goal
讓登入後的學生能對活動報名，或取消已報名的活動。

## Requirements
- `RegistrationService`：`register`、`cancel`、`isRegistered`、`spotsLeft`、`myEvents`
- 詳情頁的按鈕依狀態切換：報名 / 取消報名 / 名額已滿
- 未登入點報名要提示先登入
- 名額滿、重複報名要擋下並提示

## Acceptance Criteria
- [x] 登入後可報名成功、名額減少
- [x] 可取消報名
- [x] 名額滿時不可報名
- [x] 未登入會提示先登入

## Out of Scope
- 「我的報名」清單頁（另一個任務）

## Technical Notes
- 影響檔案：`lib/services/registration_service.dart`、`event_detail_page.dart`
- 依賴：註冊/登入（auth）＋ 活動列表/詳情（event-list）。這是匯流點。
