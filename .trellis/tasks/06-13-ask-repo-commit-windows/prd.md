# Ask GitSync 強化 — commit 時間、分群視窗、時效性比對

## Goal

針對 W5「Ask GitSync」統一問答的實機回饋，改善 `askRepo` flow 與其前端來源面板，
讓回應更有時間感、更有結構、更不會洩漏內部實作細節。對應 demo 6/18。

## Background（現況 inspection 2026-06-13）

- `DayCommit`（`tools/dailyIntel.ts`）**沒有時間欄位** — `toDayCommit` 從未讀 `committedAt`，
  所以來源卡片根本沒有時間可顯示。
- `askRepo` flow（`flows/askRepo.ts`）把所有 commit 收進**單一扁平 deduped map**，
  硬上限 `MAX_SURFACED_COMMITS = 12`；前端只渲染**一個** `_CommitSourcesPanel`，
  標頭 `Source commits (12)`（`app_strings.dart:306`）直接印出數字 → 看起來像「被限制到 12」。
- prompt 從未要求 agent 比對時間、也未要求分群，更沒告訴它不要對使用者講內部上限。

## Requirements

### 1. Commit 時間（精確到小時）
- `DayCommit` 新增 `committedAt: string | null`（ISO 8601），`toDayCommit` 從 Firestore
  `committedAt` Timestamp 轉出。
- 所有把 commit 餵給 agent 的工具結果都帶 `committedAt`，agent 才看得到時間。
- 前端 `DailyBriefSource` 新增 `committedAt: DateTime?`，來源卡片顯示到「小時」
  （例：`倪嘉駿 · 06-13 14:00 · ab12cd`）。

### 2. 動態分群視窗，不外洩上限
- 移除「永遠 12」的觀感：改成 **agent 驅動的分群**。`listDayCommits` 新增可選
  `authorLogin` / `taskId` 過濾；agent 對「整體專案狀態」類問題會：先讀 roster 或任務，
  再**每個成員 / 每個任務各呼叫一次** `listDayCommits`，每次呼叫成為一個帶標籤的 commit 視窗。
- callable 回傳 `commitGroups: [{ label, commits[] }]`；前端**每群一個面板**，
  標頭用群組標籤（人名 / 任務），而非裸數字。
- 單純「今天有什麼」→ 只呼叫一次 → 自然就是一個約 10 筆的視窗。
- 分群維度由 **agent 依問題自選**（問人→依成員；問功能/進度→依任務）。
- prompt 明令 agent **不得對使用者提及任何內部顯示上限 / 截斷**。
- 保留每群上限（per-group cap）與總安全上限，但不對外講。

### 3. 時效性比對
- `committedAt` 進入工具結果後，prompt 新增規則：遇到「最新 / 最近 / 誰最後 / 何時起 /
  在某時間前後」等時效性問題，必須依 `committedAt` 排序、比對先後再作答，並引用相關時間。

## Acceptance Criteria
- [ ] 來源 commit 卡片顯示提交時間，精確到小時。
- [ ] 問「今天有什麼進展」→ 單一視窗、約 10 筆、不顯示「12」字樣。
- [ ] 問「整個專案現在狀態」→ 多個帶標籤視窗（每人 / 每任務一個），不混成一坨。
- [ ] agent 回應文字不出現「最多顯示 N 筆 / 限制 / 截斷」等內部上限字眼。
- [ ] 時效性問題（最新/誰最後動）答案有依時間排序並引用時間。
- [ ] 亮 / 暗色模式皆正常；既有 fake backend 與 dailyBrief 聊天不受影響。
- [ ] `functions` typecheck + jest 綠燈；Flutter analyze + 相關 widget/vm 測試綠燈。

## Out of Scope
- Discord 來源面板分群（維持現狀）。
- 後端為 author/task 過濾新增 Firestore composite index（改用 in-memory 過濾既有 range 結果）。
- dailyBrief（Summary tab）回應格式的對等改造（只共用 `DailyBriefSource` 的 committedAt 欄位）。

## Technical Notes
- 分群在 flow 層做：`runTool` 拿 `listRangeCommits` 的 range 結果後，依 `authorLogin`/`taskId`
  在 TS 端 in-memory 過濾，避免新增 composite index（live 安全）。
- 群組標籤即資料（人名 / 任務 id），無標籤的群（一般近期視窗）由前端 fallback 顯示
  本地化預設標頭。
- 回應同時保留扁平 `commits`（向後相容 fake service / 既有測試）與新 `commitGroups`；
  前端 `AskRepoReply.fromMap` 優先用 `commitGroups`，缺省時把 `commits` 包成單群。
- 時間格式到小時：`MM-dd HH:00`（沿用既有 colorScheme，不硬編碼顏色）。
