# 實作使用者註冊 / 登入

## Goal
讓學生能建立帳號並登入，後續報名功能才知道「誰」在報名。

## Requirements
- `AuthService`：`signUp`、`login`、`logout`，並暴露 `current` / `isLoggedIn`
- 登入頁 `LoginPage`：可切換「註冊 / 登入」兩種模式
- 重複 email 註冊、查無帳號登入要顯示錯誤訊息

## Acceptance Criteria
- [x] 可註冊新帳號並自動登入
- [x] 可用既有 email 登入
- [x] 可登出
- [x] 錯誤情境顯示提示

## Out of Scope
- 密碼驗證 / 安全性（demo 不驗密碼）

## Technical Notes
- 影響檔案：`lib/services/auth_service.dart`、`lib/views/auth/login_page.dart`
- 無前置依賴，可與活動列表平行開發。
