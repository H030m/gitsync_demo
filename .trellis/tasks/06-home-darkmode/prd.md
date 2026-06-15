# 設計首頁與深色模式

## Goal
提供清楚的 App 入口頁，並讓使用者切換亮色 / 深色主題。

## Requirements
- `HomePage`：導向「瀏覽活動」「我的報名」「登入/登出」
- `ThemeController`：切換 `ThemeMode`，全 App 即時套用
- 亮色與深色皆需正常呈現（見 CLAUDE.md UI 規範）

## Acceptance Criteria
- [x] 首頁有各功能入口
- [x] 右上角可切換亮 / 深色
- [x] 兩種模式畫面皆正常

## Out of Scope
- 自訂主題色（單一 seed color）

## Technical Notes
- 影響檔案：`lib/views/home/home_page.dart`、`lib/theme/app_theme.dart`
- 無前置依賴，可獨立平行開發。
