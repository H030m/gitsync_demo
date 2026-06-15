# Discord AI chat: ask-AI box + searchDiscordMessages tool + scrollable cited messages

## Goal

把 Daily 的 Discord 分頁從「聊天訊息列表」改成「與 AI 對話的聊天框」。使用者問 AI 關於團隊 Discord 聊天的問題；AI 透過一個可呼叫的 function 撈出相關訊息，並把這些相關訊息顯示在中間、可滑動的面板，讓使用者瀏覽。

## Decisions (locked)

- **D1 後端 = 新 callable `discordChat`**：agentic OpenAI function-calling loop（沿用 `assignTaskFlow` 模式：`chat.completions.create` + `tools` + `tool_choice:'auto'`）。
- **D2 AI 可呼叫的 function = `searchDiscordMessages({ query, limit })`**：對該 repo 的 `discordMessages` 做關鍵字 + recency 搜尋（**現況訊息沒有 embedding**，`onDiscordMessageCreated` 仍是 stub，所以不用 vector index；fake 模式也能跑）。
- **D3 回傳形狀**：`{ answer: string, messages: [{ messageId, authorName, content, channelId, timestamp }] }`。`messages` = loop 內所有 `searchDiscordMessages` 撈到的訊息聯集（依 messageId 去重）。
- **D4 UI**：保留 digest 卡片 + Refresh/Start date 控制（餵 ingestion）；把訊息列表換成 AI 聊天 transcript（使用者問句 + AI markdown 回答），每則 AI 回答底下嵌一個**固定高度、可內部滑動**的「相關訊息」卡片面板。
- **D5 對話語言**：AI 用使用者提問的語言回答（多為中文）。

## Acceptance Criteria

- [ ] Discord 分頁顯示 AI 聊天框，不再是純訊息列表。
- [ ] 使用者輸入問題 → AI 回答；AI 會呼叫 `searchDiscordMessages` 撈相關訊息。
- [ ] 相關訊息顯示在可滑動面板（中間區域）。
- [ ] fake backend 模式可 demo（用 DummyData.discordMessages）。
- [ ] functions typecheck / flutter analyze 全綠；新增 tool 單元測試。

## Out of Scope

- 訊息語意向量搜尋（embedding）；維持關鍵字 + recency。
- 即時串流回答（一次回完即可）。

## Technical Notes

- 相關檔：`functions/src/{tools/discordSearch.ts, prompts/discordChat.ts, flows/discordChat.ts, handlers/discordChat.ts, index.ts}`；`lib/services/functions_service.dart`（+ fake）；`lib/view_models/discord_chat_vm.dart`；`lib/router/app_router.dart`；`lib/views/daily/daily_view_page.dart`。
- 架構 [`ARCHITECTURE.md §7`](../../../docs/ARCHITECTURE.md)；callable 走 auth（沿用 `handlers/assignTask.ts`）。
