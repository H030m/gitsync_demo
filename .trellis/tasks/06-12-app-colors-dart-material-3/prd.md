# 移除 app_colors.dart，統一使用 Material 3 色盤

## Goal
移除 `app_colors.dart`，將 seed color 直接內聯到 `app_theme.dart`，讓專案統一透過 `ColorScheme.fromSeed` 派生所有顏色。

## Requirements
- 將 `app_theme.dart` 中引用的 `AppColors.primary`、`AppColors.accentDark`、`AppColors.surfaceLight`、`AppColors.surfaceDark` 替換為內聯 Color 值
- 移除 `app_theme.dart` 的 `import 'app_colors.dart'`
- 刪除 `lib/theme/app_colors.dart`
- 未被 `app_theme.dart` 使用的語義色（success、warning、error、info、primaryLight、primaryDark）一併移除

## Acceptance Criteria
- [ ] `app_colors.dart` 已刪除
- [ ] `dart analyze` 無錯誤
- [ ] 亮色 / 暗色主題色彩不變

## Out of Scope
- 更改現有色盤值
- 重新設計主題

## Technical Notes
- 只有 `app_theme.dart` 引用 `app_colors.dart`
- 未使用的語義色（success/warning/error/info）目前無任何檔案引用
