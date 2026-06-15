# 任務細節頁面 UI 重構 — 白色圓角卡片佈局

## Goal
依照設計稿重構 task_details_page.dart，將各區塊用白色圓角矩形卡片分隔，提升視覺層次。

## Requirements

### 1. 認領者卡片
- 獨立白色圓角矩形卡片
- 較大的圓形頭像（左側）
- 上方小字標籤「認領者」，下方顯示名稱
- 點擊仍觸發 assignee picker

### 2. 任務內容卡片
- 獨立白色圓角矩形卡片，包含以下子區段：
- **標題列**：icon + 「任務內容」文字 + 水平分隔線
- **任務描述**：
  - 區段標籤「任務描述」
  - 藍色圓點 + 任務標題
  - 描述文字放在淺色圓角背景框內
- **子任務**：
  - 區段標籤「子任務」
  - Checkbox 列表風格（每項一個 checkbox + 標題）

### 3. 其他區塊也改為白色圓角卡片
- Dependencies（依賴）區塊
- GitHub links 區塊
- Handoff doc 區塊
- 每個區塊各自一張白色圓角卡片，內部保持現有功能

### 4. 不變更的項目
- 背景顏色維持不變
- AppBar 維持現有樣式
- 所有現有功能（assignee picker、delete、handoff 生成等）不受影響

### 5. 主題支援
- 亮色 / 暗色模式皆正常顯示
- 使用 colorScheme 取色，不硬編碼顏色

## Acceptance Criteria
- [ ] 認領者區塊為獨立白色圓角卡片，含大頭像 + 標籤 + 名稱
- [ ] 任務內容區塊為獨立白色圓角卡片，含 icon 標題列 + 分隔線
- [ ] 任務描述顯示藍色圓點 + 標題 + 淺色圓角描述框
- [ ] 子任務顯示為 checkbox 列表
- [ ] 亮色 / 暗色模式皆正常
- [ ] 現有功能不受影響

## Out of Scope
- 背景顏色變更
- 新增功能

## Technical Notes
- 檔案：`lib/views/tasks/task_details_page.dart`
- 現有 widget：`_AssigneeRow`（第 478-519 行）、`_SectionTitle`（第 735-751 行）
- 使用 `AppDimens` 常數維持一致性
- 使用 `theme.colorScheme.surface` 作為卡片背景色（亮色白、暗色自動適配）
