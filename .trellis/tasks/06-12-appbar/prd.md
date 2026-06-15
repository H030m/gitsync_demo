# AppBar 標題全域置中

## Goal
將所有頁面的 AppBar 標題置中顯示。

## Requirements
- 在 `app_theme.dart` 的 `appBarTheme` 中設定 `centerTitle: true`
- 移除 `repo_list_page.dart` 中重複的 `centerTitle: true`（已由全域設定覆蓋）

## Acceptance Criteria
- [ ] 所有頁面 AppBar 標題置中
- [ ] dart analyze 無錯誤

## Out of Scope
- AppBar 其他樣式變更

## Technical Notes
- 影響檔案：`lib/theme/app_theme.dart`、`lib/views/repos/repo_list_page.dart`
- 共 9 個 AppBar，全域設定一次生效
