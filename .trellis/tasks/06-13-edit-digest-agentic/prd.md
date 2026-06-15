# editDiscordDigest 改 agentic + 檢索關聯訊息 + live trace

## Goal

讓「請 AI 調整這份 Discord 摘要」從單次盲改升級成 agentic：agent 依改寫指令自行去
**檢索關聯訊息 / 鄰近日摘要** 取得佐證，再改寫；過程即時串 trace 到前端。對應 demo 6/18。

## Background（現況 inspection 2026-06-13）

- `editDiscordDigestFlow`（`flows/editDiscordDigest.ts`）目前是**單次** `chat.completions.create`：
  只吃「現有 digest markdown + instruction」，無任何檢索、無 trace。
- Lock 語意（ARCHITECTURE §7）：`locked===true` 直接丟 `failed-precondition`，不改。
  missing day 丟 `not-found`。
- **flow 由兩個 caller 共用**：app callable（`handlers/editDiscordDigest.ts`）與
  bot bridge（`handlers/botEditDigest.ts`）。bot 路徑無 client、無 runId、不顯示 trace。

## Requirements

### 1. flow → 工具迴圈
- seed context = 現有 digest markdown + instruction + 該 digest 的日期。
- agent 可呼叫：
  - `searchDiscordMessages(query)` — 撈與指令相關的原始訊息佐證（**新檢索能力**）。
  - `getDaySummary(date)` — 讀鄰近日 digest 補脈絡（沿用 discordSearch 工具）。
  - `writeDigest(markdown)` — 收尾，結束迴圈。
- caps：`MAX_ROUNDS` / `MAX_TOOL_CALLS`，到頂強制 `writeDigest`，保證收斂。
- 改寫後沿用既有 lock 再檢查 + 寫回（`markdown`/`editedAt`/`lastEditInstruction`，merge）。

### 2. trace（僅 app callable 路徑）
- `EditDiscordDigestInput` 加可選 `runId`；app handler 取並驗證後傳入；bot bridge 不傳（no-op）。
- `startRun(…, 'editDiscordDigest')` → 每輪 `appendStep` → `finishRun`，best-effort。

### 3. lock / 錯誤語意不變
- locked → `failed-precondition`、missing day → `not-found`，兩 caller 一致。
- 工具迴圈跑之前先檢查 lock，避免白花 OpenAI 呼叫。

## Acceptance Criteria
- [ ] 改寫 digest 時前端即時顯示思考步驟（含 Searching Discord… / Reading a day's digest… /
      Rewriting the digest…）。
- [ ] 改寫結果在相關時引用實際訊息/鄰近日佐證；無佐證時仍能完成改寫、不報錯。
- [ ] locked digest 仍被拒（failed-precondition）；missing day 仍 not-found。
- [ ] bot bridge（botEditDigest）路徑照舊可運作、無 trace、不因 runId 缺席而失敗。
- [ ] 無 runId / 舊 client 相容；app handler 對非法 runId 回 invalid-argument。
- [ ] `functions` jest（含 editDiscordDigest / botEditDigest 既有測試，必要時更新）+ typecheck
      綠燈；Flutter analyze 綠燈。

## Out of Scope
- 背景 `discordDailyDigest`（首次自動生成）改 agentic（無觀眾，維持單次全量摘要）。
- digest lock UI / 前端 strip 接線細節由 #5 統籌。

## Technical Notes
- 先 lock 檢查、後迴圈：省成本且符合既有「locked 不動」契約。
- bot bridge 與 app 共用同一 flow，只差是否帶 runId；trace 在無 runId 時自然 no-op，
  不需為 bot 分叉邏輯。
- `writeDigest` 收尾的 markdown 為空時 fallback 回原 digest（沿用現有 `|| current`）。
