# Task Details 頁面 UI 精修

## Goal
修正 task_details_page.dart 的 6 項 UI 問題，使其更符合設計稿並提升一致性。

## Requirements

### 1. 修正卡片標題重複
- Header row 應使用不同的 l10n key（如 `taskContent` = 「任務內容」）
- Sub-section label 保持 `descriptionSection`（「任務描述」）

### 2. 恢復 Status 顯示
- 在認領者卡片的 Row 右側加入 `_StatusChip`

### 3. 子任務加分隔線
- 每個子任務之間加 Divider

### 4. 認領者卡片加 chevron
- Row 尾端加 `Icons.chevron_right` 提示可點擊

### 5. 卡片間距統一
- 所有卡片間距統一用 `spacingSm`
- 修正 GitHub 條件區塊和 Handoff 的間距邏輯

### 6. 描述框暗色模式對比度
- 亮色模式維持 alpha 0.5
- 暗色模式提高 alpha 到 0.8

## Acceptance Criteria
- [ ] Header 和 sub-section 使用不同文字
- [ ] Status chip 顯示在認領者卡片右側
- [ ] 子任務有分隔線
- [ ] 認領者卡片有 chevron icon
- [ ] 卡片間距一致
- [ ] 暗色模式描述框對比度足夠
- [ ] dart analyze 無錯誤

## Out of Scope
- 其他頁面修改
