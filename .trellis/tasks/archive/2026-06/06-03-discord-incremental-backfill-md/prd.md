# Discord incremental backfill + start date + Markdown rendering

## Goal

三個相關需求合併處理：(1) App 把 AI 產出的 Markdown 真的渲染成排版；(2) Discord bot 回補可設「起始日期」、範圍可調（不再固定只抓今天）；(3) 增量抓取——設定日期後，之後每次只抓上次之後的新訊息，不重抓已進 Firestore 的訊息。

## What I already know

- 現況 bot `backfill.ts`：`fetchDayMessages` 用 **Asia/Taipei 當天 `[00:00,24:00)`** 邊界 + `before` 游標分頁，**只抓今天**。
- `requestDiscordFetch`（onCall）目前收**單一 `date`**（YYYY-MM-DD），寫 `fetchRequests/{id}`。`claimDiscordFetch` 回 `{requestId, repoId, date, channelIds}`。
- 去重**已有**：`discordMessageIngest` 用 `messageId` + `ref.create()`，重送回 `{dup:true}`，**不會產生重複 doc**。但 bot 仍會「重抓整批 + 重送」→ 浪費 invocation/Discord API。
- App 顯示：digest 卡片 + daily summary 在 `lib/views/daily/daily_view_page.dart`、handoff 在 `lib/views/tasks/task_details_page.dart`，**全部用純 `Text`**（markdown 不渲染）。
- **尚無 markdown 套件**（pubspec 沒有）。課程指定套件：provider / go_router；UI 另用 google_fonts、(fl_chart)。加 UI 套件先例存在。
- Discord REST `channel.messages.fetch` 支援 `after`/`before`/`around` 游標 → 增量抓取可用 `after: <lastMessageId>`。

## Assumptions (temporary)

- 起始日期是**每個綁定頻道**各自一個（不同頻道可不同起點）。
- 增量水位用 **Discord message snowflake id**（單調遞增、比 timestamp 精準，且 REST 支援 `after`）。
- Markdown 只讀渲染，不需編輯器。

## Decisions (locked, Q&A 2026-06-03)

- **D1 起始日期 = App date picker**，存 per-channel；首抓 起始日→現在，之後 refresh 增量（watermark = 最後抓到的 message id）。設更早日期會補抓缺口、不刪既有。
- **D2 Markdown 範圍**：先做一個**可重用的 `MarkdownView` widget**，這次只套用在 **Discord digest 卡片**；daily summary / handoff 留著之後直接換上同一 widget（本 task 不接線，但留好接口）。
- **D3 套件 = `flutter_markdown`**。
- **D4 watermark/起點用 Discord message snowflake**：起始日期 → 起始 snowflake `(unixMs-1420070400000)<<22`，REST `channel.messages.fetch({ after })` 增量抓。重設更早起始日 → 把該頻道 watermark 退回起始 snowflake（下次補抓缺口），不刪 doc（messageId 去重保證不重複）。
- **D5 digest 維持 per-day（今天）**：本 task 改的是「ingestion 範圍/增量」；digest flow 仍讀 Firestore 當天訊息產生，不改粒度。

## Requirements (evolving)

- App 渲染 AI Markdown（範圍待 Q2 定）。
- 可設定每頻道起始日期；bot 回補從該日期起。
- 增量：bot 只抓 watermark 之後的新訊息；watermark 抓完後前進。

## Acceptance Criteria (evolving)

- [ ] AI markdown 在 app 以排版顯示（標題/清單/粗體/連結）。
- [ ] 設定起始日期後，首次回補抓「起始日期 → 現在」的訊息。
- [ ] 再次 refresh 只抓上次之後的新訊息（log/invocation 可見沒有重抓整批）。
- [ ] 不產生重複 doc（既有 messageId 去重維持）。
- [ ] functions typecheck / discord-bot build / flutter analyze 全綠。

## Definition of Done

- 三 gate 全綠；英文 code/comments（docs 中文）；Firestore 寫入仍走 Cloud Functions；ARCHITECTURE §7 + MEMORY 視情況更新。

## Out of Scope (explicit)

- 即時抓取（維持 on-demand）。
- Markdown 編輯 / 雙向同步。

## Technical Notes

- 相關檔：`discord-bot/src/backfill.ts`、`functions/src/handlers/requestDiscordFetch.ts` / `claimDiscordFetch.ts` / `completeDiscordFetch.ts`、`functions/src/flows/discordDailyDigest.ts`、`lib/views/daily/daily_view_page.dart`、`lib/views/tasks/task_details_page.dart`。
- bot 無 Firestore 憑證 → watermark 讀寫須透過 secret-auth function 中轉（沿用模式）。
- 架構 [`ARCHITECTURE.md §7`](../../../docs/ARCHITECTURE.md)。

## Technical Approach

**Per-channel 設定 + watermark 存哪**：新增 subcollection `repos/{repoId}/discordChannels/{channelId}`，欄位 `{ guildId, startDate?: string(YYYY-MM-DD), lastMessageId?: string, addedAt }`。保留 `repos/{repoId}.discordChannelIds: string[]` 當「有哪些頻道」的快速清單（`setRepoChannel` arrayUnion 時同時 create 此 subcollection doc）。

**Functions（contract 變更）**：
- `setRepoChannel`：除了 arrayUnion channelId，另 set 該頻道 subcollection doc（含 guildId）。
- 新增 `setChannelStartDate`（callable, auth）：app date picker 呼叫，寫 `discordChannels/{channelId}.startDate` 並把 `lastMessageId` 退回（reset 讓下次從新起點補抓）。
- `claimDiscordFetch`：回傳改成 per-channel 陣列 `[{ channelId, startDate, lastMessageId }]`（取代只回 `channelIds`）。
- `completeDiscordFetch`：收 bot 回報的 per-channel 最新 messageId → 更新各頻道 `lastMessageId`（watermark 前進）；再跑 digest（date=今天，不變）。

**Bot（`backfill.ts`）**：對每個頻道用 `channel.messages.fetch({ after: lastMessageId ?? snowflake(startDate) })`，往新方向分頁（`after` 游標）抓到最新；過 `shouldKeepMessage` → POST `discordMessageIngest`（去重不變）；記錄該頻道抓到的最大 messageId，最後一起回報給 `completeDiscordFetch`。snowflake 換算工具 bot/functions 各一份（小函式）。

**App**：
- 新增可重用 `lib/widgets/markdown_view.dart`（包 `flutter_markdown` 的 `MarkdownBody`，套 app 主題）。
- digest 卡片改用 `MarkdownView`。
- Daily→Discord 加「起始日期」date picker（`showDatePicker`）→ 呼叫 `setChannelStartDate`。需要知道「這個 repo 綁了哪些頻道」才能選對象——MVP 若只一個頻道就直接用；多頻道再加選擇。
- `pubspec.yaml` 加 `flutter_markdown`。

## Implementation Plan (small PRs)

- **PR1 — functions + rules**：`discordChannels` subcollection、`setChannelStartDate`、改 `setRepoChannel` / `claimDiscordFetch`（per-channel 回傳）/ `completeDiscordFetch`（更新 watermark）；snowflake util；rules（`discordChannels` write:false、member 可讀）；unit tests。
- **PR2 — discord-bot**：`backfill.ts` 改用 `after` 游標 + per-channel start/watermark；回報最新 messageId；snowflake util。build 綠。
- **PR3 — Flutter**：`MarkdownView` widget + digest 套用；Daily→Discord date picker 串 `setChannelStartDate`；`pubspec` 加套件。`flutter analyze` 綠。
- **Docs**：ARCHITECTURE §7 更新（per-channel watermark + 增量 + start date）；MEMORY 記決策。

## Open decisions log

- 2026-06-03：D1–D5 鎖定（見 Decisions）。
