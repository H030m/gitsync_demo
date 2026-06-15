# Discord range backfill: two-cursor window + prune + persisted range picker + digest scroll

## Goal

把 Discord 回補從「單一起始日期」改成「**日期範圍 [start, end]**」的雙指針 cursor 模型，並修掉相關問題：
1. digest 展開後內容過長 → 可滑動（修 overflow）。
2. cursor 問題：A 已讀到 7 日、把起始改到 5 日時，因為 watermark(7) > snowflake(5) 而抓不到前面 → 用 **low/high 兩個 cursor** 維持範圍。
3. 更動範圍時，把**超出新範圍的訊息刪掉**，對應的**日報（digest）也刪掉**。
4. 日期選取改成**範圍選取**（起始 + 結束）。
5. picker 預設停在**使用者已設定並記住的位置**（存 Firestore → 重新登入仍維持），不是每次都跳今天。

## Decisions (locked)

- **D1 範圍 repo-wide**：存 `repos/{repoId}.discordStartDate` / `discordEndDate`（YYYY-MM-DD）。沿用先前「起始日期一個共用就好」的決定。
- **D2 雙 cursor（衍生自範圍）**：`lowCursor = snowflake(start@00:00 Taipei)`、`highCursor = snowflake((end+1day)@00:00 Taipei)`（上界 exclusive）。per-channel `lastMessageId` 仍是增量高水位。bot 抓 `after: lastMessageId ?? lowCursor`，且**忽略 id ≥ highCursor 的訊息**（不抓 end 之後）。
- **D3 新 callable `setDiscordRange(repoId, startDate, endDate)`**（取代 app 對 `setDiscordStartDate` 的呼叫）：寫範圍 → reset 各頻道 watermark（`FieldValue.delete()`）讓下次重抓新範圍 → **prune**：刪 `discordMessages`（timestamp < start@00:00 或 ≥ (end+1)@00:00）、刪 `discordDigests/{date}`（date < start 或 > end）。`setDiscordStartDate` 保留不刪（向後相容）。
- **D4 picker = `showDateRangePicker`**，`initialDateRange` = 已存範圍（VM 透過 `RepoRepository.streamRepo` 讀 repo doc）；無則 [today, today]。選完呼叫 `setDiscordRange`。
- **D5 digest 跟著 endDate**：VM 的 digest 訂閱改用 endDate（範圍最新一天）；範圍變更時重新訂閱。digest 仍 per-day（不做整段每天 digest，超出範圍）。
- **D6 digest 展開內容**：`MarkdownView` 包 `ConstrainedBox(maxHeight) + SingleChildScrollView` 可滑動。

## Contract (layers code to this)

- callable `setDiscordRange` data `{ repoId, startDate:'YYYY-MM-DD', endDate:'YYYY-MM-DD' }` → `{ ok, channelCount, prunedMessages, prunedDigests }`；`start <= end` 否則 `invalid-argument`。
- `claimDiscordFetch` response 新增 top-level `startDate?: string|null`、`endDate?: string|null`（repo doc 讀）。
- repo doc 欄位 `discordStartDate`、`discordEndDate`。
- bot 端 `fetchMessagesAfter` 加上界 `highCursor`（只收 `id < highCursor`）。

## Acceptance Criteria

- [ ] 設定範圍 [5日, 7日] 後，bot 從 5 日重抓、且不抓 7 日之後；既有 8 日後的訊息與 digest 被刪。
- [ ] 範圍變更後，超出範圍的 `discordMessages` 與 `discordDigests` 被刪。
- [ ] 日期選取是範圍 picker，預設停在已存範圍；重新登入仍維持。
- [ ] digest 展開過長內容可滑動。
- [ ] functions tsc + jest、discord-bot build、flutter analyze、flutter test 全綠。

## Out of Scope

- 為範圍內「每一天」各產生 digest（維持 per-day，對 endDate）。
- per-channel 各自不同範圍（範圍 repo-wide）。

## Technical Notes

- snowflake helper 兩份（bot + functions）需同步加 day-end（next-day start）換算。
- prune 用 batched delete（chunk ~450）。
- 相關檔：`functions/src/{handlers/setDiscordRange.ts,handlers/claimDiscordFetch.ts,tools/discordSnowflake.ts,index.ts}`、`discord-bot/src/{backfill.ts,snowflake.ts}`、`lib/{models/repo.dart,view_models/discord_messages_vm.dart,services/functions_service.dart(+fake),views/daily/daily_view_page.dart}`、`test/repo_list_vm_test.dart`。
