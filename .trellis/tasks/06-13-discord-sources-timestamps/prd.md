# Ask GitSync / Discord — 來源時間戳 + Discord 相關訊息統整

## Goal
回應實機回饋,讓問答與 Discord 摘要的「來源」更有時間感、更有所本:
1. commit 與 Discord 來源卡片都**明確標出時間**(`2026/06/13 14:00`),讓使用者知道參考的是哪個時間點。
2. **講解 Discord 訊息時也要列出相關原始訊息**(像 commit 來源面板),而不只是大綱——
   涵蓋兩個畫面:Ask GitSync 問答 + Discord 每日摘要(digest)。
3. (已於 `06-13-ask-repo-commit-windows` 完成、待 deploy)commit 以 user 為單位多次調用、
   分成多個視窗、不外洩上限。

## Background（inspection 2026-06-13）
- 使用者截圖仍是「來源 commit (12)」、無時間、未分人 → 因為 **askRepo 後端尚未 deploy**;
  前端把舊版扁平 `commits` 包成單一無標籤群、顯示預設標頭。分群/時間/分人皆 deploy 後生效。
- `DayCommit.committedAt` 已打通到 `DailyBriefSource.committedAt`;commit 卡片目前顯示
  `MM-dd HH:00`(缺年份)。
- Discord snippet 每則訊息**早已帶 `timestamp`**(`DiscordChatSource.timestamp`,ISO),
  但 askRepo 的 `_DiscordSourcesPanel` **沒有渲染時間**。
- Discord 每日摘要存 `discordDigests/{date}: {date, messageCount, markdown}` —
  只有 markdown 大綱,**沒有它參考了哪些原始訊息**。Discord tab 雖在摘要下方另列當天訊息,
  但摘要本身不引用、訊息列也未必有時間。

## Requirements

### R1. 來源時間戳（前端）
- commit 卡片:`2026/06/13 14:00`(完整年月日 + 時:分,本地時區)。
- askRepo `_DiscordSourcesPanel` 每則訊息:顯示 `2026/06/13 14:00`(由既有 `timestamp` 解析)。

### R2. askRepo prompt（後端）
- 時效性問題:依 `committedAt` / Discord `timestamp` 排序、引用時間。
- 廣問題:commit 依人/任務多次調用;Discord 依主題/人多次 `searchDiscordMessages`,
  讓相關訊息以多個面板分開呈現。

### R3. Discord 摘要引用來源（後端 + 前端）
- 摘要產生(`discordDailyDigest` / `editDiscordDigest`)時,同時保存它參考到的原始訊息
  (id / author / content / timestamp),存進 digest doc 的 `sourceMessages`。
- Discord tab 的 digest 卡片在 markdown 下方附「參考訊息」清單,每則帶時間。
- 向後相容:舊 digest 無 `sourceMessages` → 不顯示該區塊(degrade)。

## Acceptance Criteria
- [ ] commit 與 Discord 來源卡片都顯示完整日期時間(年/月/日 時:分)。
- [ ] askRepo 回答涉及 Discord 時,相關原始訊息以面板列出且每則有時間。
- [ ] Discord 每日摘要下方列出它參考到的訊息(含時間);舊資料不爆。
- [ ] functions typecheck + jest 綠;flutter analyze 0 新增、相關測試綠。
- [ ] 全部完成後**一次** deploy functions。

## Out of Scope
- Discord snippet 以 user 為單位硬分群(對話本含多位作者,維持以「查詢/主題」為單位的面板)。
- 為 Discord 來源新增 Firestore composite index。

## Technical Notes
- 時間格式統一 helper:`yyyy/MM/dd HH:mm`(本地時區),commit 與 Discord 共用。
- digest `sourceMessages` 由 flow 端 in-memory 收集(沿用 listRangeDiscordMessages / 既有檢索),
  不新增 index;上限數十則防膨脹。
