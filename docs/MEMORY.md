# 團隊決策備忘 (MEMORY)

> **不是個人日誌**——這裡只記**會影響別人怎麼寫程式**的決策。個人進度寫 [`journal/<你的名字>.md`](./journal/)。
>
> 最新決策在最上面。

---

## 2026-06-03 — Discord 增量回補（per-channel watermark + 起始日期）+ AI Markdown 渲染

承 [2026-06-02 on-demand 回補] 再強化：

- **增量、不重抓**：每個綁定頻道存 watermark（`repos/{repoId}/discordChannels/{channelId}.lastMessageId`）。bot 用 Discord REST `messages.fetch({ after })` 只抓 watermark 之後的新訊息，抓完把 watermark 前進（`completeDiscordFetch` 收 bot 回報的最新 messageId 更新各頻道）。已進 Firestore 的訊息靠既有 messageId 去重，不再重抓整批。
- **起始日期**：App「Daily→Discord」date picker 呼叫 `setDiscordStartDate({repoId, startDate})`（callable, auth），對該 repo 所有頻道寫 `startDate` 並 reset watermark → 下次從新起點補抓（缺口補上、不重複）。首抓 cursor = `lastMessageId ?? snowflake(startDate)`；snowflake 由日期換算 `((unixMs-1420070400000)<<22)`，bot/functions 各一份（`discordSnowflake.ts` ↔ `snowflake.ts`）須同步。
- **新 schema**：`repos/{repoId}/discordChannels/{channelId}` subcollection（`startDate`/`lastMessageId`/`guildId`）。保留 `discordChannelIds` 陣列當快速清單；`claimDiscordFetch` 改回傳 per-channel `[{channelId,startDate,lastMessageId}]`（仍相容舊 `channelIds`）。
- **AI Markdown 渲染**：新增可重用 `lib/widgets/markdown_view.dart`（`flutter_markdown` 的 `MarkdownBody` + 主題）。先套在 Discord digest 卡片；daily summary / handoff 之後可直接換上同一 widget。`flutter_markdown` 已 discontinued（官方轉 `flutter_markdown_plus`）但現版本對期末 demo 足夠。

理由：使用者要可設起始日期、之後只抓新訊息、AI 產出排版好看。digest 仍維持 per-day（本次只改 ingestion 的範圍/增量）。

詳見 [`ARCHITECTURE.md §7`](./ARCHITECTURE.md) + task `06-03-discord-incremental-backfill-md`。

## 2026-06-02 — Discord 改 on-demand 回補 + 頻道對照移進 Firestore（移除即時轉發）

Discord ingest 從「常駐 forwarder 即時轉發每則訊息」改成 **on-demand 批次回補**：

- **觸發**：App「Daily → Discord」refresh → `requestDiscordFetch` callable 寫 `fetchRequests/{id}`（`status:'pending'`）。bot 沒有對外 URL，所以走 **Firestore queue 中轉**——常駐 bot 每 ~5 秒輪詢 `claimDiscordFetch`（secret-auth）認領，REST 回補當天訊息 → `discordMessageIngest` → `completeDiscordFetch` → `discordDailyDigestFlow` 寫 `discordDigests/{date}`。
- **頻道對照**：從 bot 靜態 `.env` `CHANNEL_REPO_MAP` 改成 Firestore `repos.discordChannelIds`，用 **`/gitsync-listen url:<repo-url>` slash command** → `setRepoChannel`（secret-auth）`arrayUnion` 綁定。
- **bot 移除 `MessageCreate` 即時轉發**；但 **`MessageContent` intent 仍必開**（REST `messages.fetch` 才回得到 `content`）。
- **新增 collection**：`fetchRequests`（請求佇列）、`discordDigests`（AI 每日 digest）。bot 仍無 Firestore 憑證，所有讀寫透過 secret-auth function 中轉（不發 service-account key）。

理由：團隊決定不要常駐即時串流（噪音多、bot 一掉訊息就漏），改成「要看才拉、拉完 AI 整理成 digest」；頻道設定放 Discord 內比 App 內挑選器直覺。**代價**：bot 仍需 24/7 常駐（為 slash command + 輪詢）；訊息只在 refresh 時更新（非即時，可接受）。

**OAuth scope 連帶變更**：bot 邀請要從 `bot` 改成 `bot` + `applications.commands`（重新邀請）；Bot Permissions 維持唯讀 `View Channels` + `Read Message History`（66560）不變。

⚠️ **待辦（owner）**：`firestore.rules` 目前仍是 firebase-init 的 30 天大開放規則（到 2026-06-25），尚未套用 [§2.2](./ARCHITECTURE.md#22-firestore-security-rules) 硬化版；硬化時 `fetchRequests` / `discordDigests` 要設 `allow write: if false`（只 Cloud Functions 寫）、`discordDigests` 開放 repo member 讀。

詳見 [`ARCHITECTURE.md §7`](./ARCHITECTURE.md#7-discord-整合on-demand-回補版)。取代下方 2026-05-26「Discord 簡化為訊息直接寫 Firestore」與 forwarder 即時轉發相關段落。

## 2026-06-02 — 首次 live 部署成功 + Cloud Functions 部署三連坑

`gitsync-645b3` 完成第一次 Cloud Functions 部署（`addRepo` + `githubWebhook`），並用真實 GitHub OAuth 登入 + 加 repo 端到端驗證通過。過程踩到三個**一次性**設定坑，已寫進 [`SETUP.md §5.9`](./SETUP.md)：

1. **deploy 跳 secret prompt**（即使 targeted）→ 先 `firebase functions:secrets:set OPENAI_API_KEY / DISCORD_INGEST_SECRET`（測非 AI 函式可填 placeholder）。
2. **Build failed: missing permission on build service account** → 給 `<專案號>-compute@developer.gserviceaccount.com` 角色 `roles/cloudbuild.builds.builder`。
3. **callable 回 `[firebase_functions/internal]`、log 出現 `Empty Authorization header`** → Cloud Run 服務設「允許公開存取」(allUsers `run.invoker`)；auth 仍在函式內檢查。

這些是**每個新 Firebase 專案各做一次**的 infra 設定，不是 code 問題。部署/IAM/secret 指令一律由人親跑（AI 禁止，§R1/§R2）。

## 2026-06-02 — 課程約束：Final Demo 僅能用 Flutter + Firebase

課程公告：Final Demo 的開發工具**嚴格限定僅能使用課堂教學的 Flutter 與 Firebase**。**禁止**使用其他後端語言或框架（Python / Go / Node.js 等）**自行搭建外部伺服器**。核心要求是整合 Flutter + Firebase 的各項功能。

**Cloud Functions 允許**（2026-06-02 向課程確認：上課教過，屬「允許的 Firebase 整合」）。所以本專案後端 `functions/`（TypeScript Cloud Functions）可續用——公告括號的「Node.js」指「自架 Node 伺服器」，不含 Firebase 託管的 Functions runtime。

**判準**：只要是 Firebase 第一方產品（Firestore / Auth / Cloud Functions / FCM / Storage / Extensions…）即可；禁止的是在 Firebase 之外另起一個自管 server（VPS / 自架 Cloud Run 上的 Express / Flask / Go service 等）。`functions/` 的 jest / ts-jest / eslint 是本機開發工具、非伺服器，允許保留。

理由：違反此限制可能影響 Final Demo 成績；屬硬性約束，不是偏好。所有架構建議都要卡這條。

## 2026-05-26 — AI 收尾回報多加一欄「建議 commit message」（五欄格式）

[`AI_AGENT_RULES.md §4.6`](./AI_AGENT_RULES.md#46-給使用者的回報) 從 ✅📁⚠️🧪 四欄擴成 **✅📁⚠️🧪💬 五欄**——多了 💬 建議 commit message。詳細格式守則見新增的 §4.6.1：英文、imperative mood、subject ≤72 字、跨範圍時拆多條 commit、AI 只生成字串不執行 `git commit`（仍受 [§R1](./AI_AGENT_RULES.md#r1-ai-不可自己-commit--push--任何寫-git-歷史的動作) 約束）。

理由：嘉駿開工時要求「寫完更改要附上 commit name 建議幫助其他人看懂」。AI 反正都有完整脈絡（剛改過什麼、為何改），順便產一行 git history 用的訊息成本是 0，但能讓人類隊員 review PR 與 commit log 時看懂。

## 2026-05-26 — 所有程式碼與註解一律用英文，APP 字串也是

包括 Dart (`lib/`) 與 TypeScript (`functions/`) 兩邊，所有：
- identifier / variable / function 名（本來就 English）
- inline comment / docstring / TODO
- UI 字串（button text、page title、error message）

例外：`docs/` 下的 Markdown（journal / MEMORY / ARCHITECTURE / COURSE_METHODS）**維持中文**——這是文件，給人讀的，不是程式碼。

理由：嘉駿開工時使用者明確要求「請用英文寫程式，包含 APP 的內容以及註解」。統一英文方便五個 AI 接力時 prompt 不會因為語言切換錯亂，也讓未來 demo / 課堂展示時 UI 字串不用再翻譯一次。

## 2026-05-26 — Secrets 兩層儲存：root `secrets/` + `functions/.secret.local`

依使用者指示，所有 API key / OAuth token 集中放在 `gitsync/secrets/`（已 gitignore）：
- `secrets/openai.env`、`secrets/discord.env`、`secrets/github.env`（含真實值）
- `secrets/*.example`（範本，**入 git**，教大家如何填）
- `secrets/README.md`（setup 教學、漏 key 應急流程）

同時依 Firebase emulator 慣例保留 `functions/.secret.local` 給本機 emulator 使用——值必須與 `secrets/openai.env` 等同步。

**正式部署仍走 Google Secret Manager**（`firebase functions:secrets:set ...`，由人類親跑——AI 禁止），不讀本地檔。

## 2026-05-26 — `analysis_options.yaml` 關閉 `prefer_initializing_formals`

此 lint 跟 [課程 model pattern](./COURSE_METHODS.md#41-model--null-safe--firestore-timestamp)（私有 `_createdAt` 欄位 + 公開 getter fallback `Timestamp.now()`）以及 ViewModel 在 ctor body 內掛 stream subscription 的寫法衝突。改用 initializing formal 反而會破壞那兩個 pattern。整個 project 直接把這 rule 設成 `false`。

如果之後新加的純資料 class 想用 initializing formal，自己加 `this._field` 寫法即可，rule 沒開就不會抱怨。

## 2026-05-26 — ARCHITECTURE.md 文體規範：實作改寫為敘述

ARCHITECTURE.md 是「給人看 + AI 看」的設計文件，不是 reference implementation。所有 TS / Dart 實作 code 一律改寫為敘述（行為條列、責任清單、輸入輸出 contract）。

**保留 code 的例外**：
- 顏色 / theme token（精確值需要）— §8.1 dart theme
- Firestore Security Rules（DSL 語法精確度需要）— §2.2
- 部署 / 維運指令（`gcloud` / `firebase deploy` 等）— §5.4 / §5.6 / §12
- 設定檔結構範例（`firestore.indexes.json`）— §5.6
- ASCII 圖（不是 code）— §1 / §7.1
- Firestore schema tree（結構化清單）— §2.1

**理由**：實作 code 在 ARCHITECTURE 容易過時、佔篇幅、reviewer 揪不出邏輯漏洞會被困在語法細節。Sprint 1 隊員依敘述自己寫 code，要參考具體寫法去 [`COURSE_METHODS.md`](./COURSE_METHODS.md)。

## 2026-05-26 — `dependsOn` 型別契約：LLM 端用 `number[]` (索引)，Firestore 端用 `string[]` (taskId)

`breakdownTaskFlow` 內部負責翻譯：
- Zod schema 定義 `dependsOn: z.array(z.number().int())`（0-based 索引）
- Step 4：pre-generate taskIds (`tasksCollection.doc().id`)
- Step 5：把 LLM 輸出的索引換成預生成的 taskId
- Step 6：transaction 批次寫入

Flutter 端永遠只看到 `string[]` taskId 版本；**不要把 LLM 原始輸出直接送進前端**。

詳見 [`ARCHITECTURE.md §5.1`](./ARCHITECTURE.md#51-flow-1--breakdowntaskflow任務拆解)。

## 2026-05-26 — `tasks.dependsOn` 必建 array-contains 複合索引

`onTaskUpdated` trigger 反向查下游時用 `where('dependsOn', 'array-contains', taskId)` + `where('status', '==', 'todo')`。沒這個複合索引 trigger 會直接 crash → 下游永不喚醒。

部署前必執行（**使用者**親跑）：
```bash
gcloud firestore indexes composite create \
  --collection-group=tasks \
  --query-scope=COLLECTION_GROUP \
  --field-config field-path=dependsOn,array-config=CONTAINS \
  --field-config field-path=status,order=ASCENDING
```

亦寫入 `firestore.indexes.json`。詳見 [`ARCHITECTURE.md §5.6`](./ARCHITECTURE.md#56-vector-search-索引與預過濾)。

## 2026-05-26 — `users` 必加 `discordUserId` 對照欄位

Discord 訊息存的是 `authorId` (Discord snowflake)，GitHub commit 存的是 `githubLogin`，Firebase Auth 用 UID。沒對照 = AI 生 handoff 時無法把對話中的人連到真實貢獻者，會張冠李戴。

實作：
- `users/{uid}.discordUserId: string?`（APP 設定頁讓用戶填 18 位 snowflake）
- `assignTaskFlow.readTeamState` & `generateHandoffFlow.readTeamRoster` 回傳必含此欄位
- AI Agent 在 draft / handoff 時自行做姓名對齊

詳見 [`ARCHITECTURE.md §2.1 users schema`](./ARCHITECTURE.md#21-collections) + [`§5.2`](./ARCHITECTURE.md#52-flow-2--assigntaskflow動態任務分派) + [`§5.3`](./ARCHITECTURE.md#53-flow-3--generatehandoffflow交接文件)。

## 2026-05-26 — Webhook ↔ Trigger 職責切分：webhook 只寫 raw，trigger 才做 AI

`githubWebhook` 等 HTTP handler **嚴禁** 解析 commit 的 `#N`、算 embedding、跨文件改 task。**只允許** 把 GitHub payload 標準化後寫進對應的 Firestore doc。所有業務語意 / OpenAI 呼叫 / 跨文件 transaction 一律下沉到 `onCommitCreated` / `onPRMerged` 等 trigger 層。

理由：
- webhook 必須毫秒級回應 GitHub（避免外部 retry 風暴），業務邏輯放 trigger 才有 idempotency key 保護
- 兩邊都寫同一邏輯 = 重複計算 + 欄位互蓋

詳見 [`ARCHITECTURE.md §4.3 / §6.3`](./ARCHITECTURE.md#43-firestore-triggers事件驅動)。

## 2026-05-26 — `breakdownTaskFlow` 必須加分散式鎖

兩人同時點「AI 拆解」會跑兩遍 → 同 goal 拆出兩套任務 + 兩倍 GitHub Issue。雙層防護：
- 前端：button disable + loading；callable 回傳前不准重按
- 後端：`repos/{repoId}.isBreakingDown` flag + transaction（鎖定 → 跑 flow → finally 解鎖）
- 兜底：`scheduledUnstickBreakdown` 排程每 10 分鐘掃 `breakdownStartedAt > 5 分鐘前` 強制解鎖

詳見 [`ARCHITECTURE.md §5.1`](./ARCHITECTURE.md#51-flow-1--breakdowntaskflow任務拆解)。

## 2026-05-26 — Discord forwarder 必須帶指數退避 retry

Cloud Functions 冷啟動 1.5–3 秒；Discord 突發多人發言會撞 cold start + 429 → 訊息丟失。Forwarder 端 `sendWithRetry` 規格：
- maxRetries = 4，base 1s，指數退避 + 100–500ms jitter
- 單次 timeout 8s（含冷啟動）
- 4xx 非 429 直接 drop 不重試（避免無謂浪費）

詳見 [`ARCHITECTURE.md §7.2`](./ARCHITECTURE.md#72-inbound--訊息怎麼進-firestore)。

## 2026-05-26 — 所有 Firestore Trigger 必須做 idempotency check

Firestore Trigger 是 **at-least-once** 交付。`FieldValue.increment(1)` 雖然原子，但同一事件被送兩次 = 加兩次。守則：
- 每個 trigger 開頭跑 transaction：(1) get idempotencyKeys/{eventId}，(2) 若已存在直接 return，(3) 否則 mark + 跑業務
- **OpenAI 等外部副作用必須在 transaction 之外做**（否則失敗會被當已處理）
- 對於 commit summary / embedding 這類「掉一兩個沒關係」的功能，接受偶發失敗、提供使用者手動重試按鈕

詳見 [`ARCHITECTURE.md §4.4 規則 C`](./ARCHITECTURE.md#44-併發-race-condition-防禦守則)。

## 2026-05-26 — Discord 訊息要在 forwarder 端先過濾，第二層在 ingest function

不可把所有 Discord 對話盲送進 Firestore + embedding（污染向量庫 + 燒 token）。雙層過濾：
1. **forwarder bot** 端先濾（純表情、`+1`、`ok`、純連結、長度<5、bot 訊息、純貼圖）→ 不送 ingest
2. **`discordMessageIngest`** 端再濾一次（用 `functions/src/tools/discordFilter.ts`，邏輯與 forwarder 同步）

兩層過濾規則必須保持一致；若改規則記得兩邊同改。

## 2026-05-26 — Discord 簡化為「訊息直接寫 Firestore」單向資料源

放棄 Discord slash command 介面（原規劃的 `/gitsync-check` / `/gitsync-daily` / `/gitsync-assign` 全部砍掉）。理由：
- Discord Interactions Webhook 有 3 秒超時硬限制；AI flow 動輒 5–15 秒，必須用 Cloud Tasks 解耦——架構複雜度爆增
- 隊員偏好讓「Discord 純聊天 → 訊息進 Firestore → APP 端整理」的單向流
- 所有「主動操作」改在 APP 內按按鈕（呼 Firebase Callable），不在 Discord

**現況**：
- Inbound：使用者**另外**跑一個小 discord.js forwarder bot（本機/VPS），POST 到 `discordMessageIngest` Cloud Function；不是 Cloud Function 端的責任
- Outbound：`onTaskUpdated` trigger 直接 POST 到 channel webhook URL（無 3 秒問題）

詳見 [`ARCHITECTURE.md §7`](./ARCHITECTURE.md#7-discord-整合簡化版)。

## 2026-05-26 — 併發守則：counter 用 atomic increment、跨欄位用 transaction

GitHub push 10 個 commit 會引發 10 個 `onCommitCreated` 併發。read-modify-write 計數會錯。一律：
- 計數欄位：`FieldValue.increment(±1)`
- 多欄位/跨文件：`db.runTransaction(...)`

詳見 [`ARCHITECTURE.md §4.4`](./ARCHITECTURE.md#44-併發-race-condition-防禦守則)。

## 2026-05-26 — 排程任務必須扇出 (Fan-out)，不可 for-loop

`scheduledDailyReport` 不可 for-loop 跑所有 repo（500 秒 timeout）。排程器只做「掃 repoId 列表 → 投 Cloud Tasks」；每個 repo 由獨立 worker function 處理。

需建立 queue：`gcloud tasks queues create daily-report-queue --location=asia-east1`。

## 2026-05-26 — Commit message embedding 前必過濾

自動產生的 commit（`Merge branch ...` / `Bump version` / `v1.2.3`）會污染向量庫又燒 token。`onCommitCreated` 算 embedding 前先過 `shouldSkipEmbedding()` regex 黑名單。

詳見 [`ARCHITECTURE.md §5.6`](./ARCHITECTURE.md#56-vector-search-索引與預過濾)。

## 2026-05-26 — 棄用 Genkit，改用 OpenAI 官方 Node.js SDK

最初計畫沿用課程教的 Genkit，後來改成直接 OpenAI SDK + structured outputs（zod）+ function calling。理由：
- 不為了用課程套件多綁一層
- Function calling 用原生 SDK 比 Genkit 抽象好除錯
- Structured outputs (`response_format`) 已能解決 schema 對齊問題，不需要 Genkit 的 `definePrompt`

詳見 [`ARCHITECTURE.md §0`](./ARCHITECTURE.md#0-技術選型總結) + [`COURSE_METHODS.md §8`](./COURSE_METHODS.md#8-ai-agent--openai-sdk-直接使用後端)。

## 2026-05-26 — Firestore 路徑統一掛 `apps/gitsync/`

所有 collection 開頭都是 `apps/gitsync/...`，沿用課程 `group-todo-list` 範例的命名慣例。**不要寫成根目錄 `users/`、`repos/`**。

## 2026-05-27 — Fake backend 模式（`AppConfig.useFakeBackend`）

App 預設用 in-memory dummy data 跑，不打 Firebase / OpenAI / GitHub / Discord。讓五人團隊任何隊員 clone repo 後 `flutter run` 就能看 UI、開發各自模組，**不需先 setup 任何 API**。

### 切換方式

```powershell
flutter run --dart-define=BACKEND=live   # 真實 Firebase（需先 flutterfire configure + 啟 GitHub OAuth provider）
flutter run --dart-define=BACKEND=fake   # in-memory dummy data
flutter run                              # 用 AppConfig.defaultBackend（目前是 fake）
```

### 設計

每個 Repository / Service 都重構成 `abstract class XxxRepository` + `_LiveXxxRepository implements XxxRepository` (Firestore-backed) + `FakeXxxRepository implements XxxRepository` (in-memory)。`UserRepository()` factory 依 `AppConfig.useFakeBackend` 選 impl。

Dummy data 在 [`lib/data/dummy_data.dart`](../lib/data/dummy_data.dart)：3 個 user、1 個 repo、8 個 task、3 個 commit、1 個 PR、3 個 Discord 訊息、1 份今日 daily report。

### Fresh clone 後的 setup

`lib/firebase_options.dart` 是 gitignored（保護 apiKey），fresh clone 後此檔不存在會編譯失敗。**clone 後第一步**：

```powershell
Copy-Item lib/firebase_options.example.dart lib/firebase_options.dart
```

之後：
- **想用 fake mode** → 不用再做任何事，`flutter run` 直接跑（fake mode 不會去 call `DefaultFirebaseOptions.currentPlatform`）
- **想用 live mode** → 跑 `flutterfire configure` 把 placeholder 換成真實值

### 留給隊員的 TODO

兩個服務的 abstract 上方都標了 `TODO(handoff to X module)`：
- [`lib/services/authentication.dart`](../lib/services/authentication.dart) → E 模組接手 GitHub OAuth 設定後刪除 TODO
- [`lib/services/functions_service.dart`](../lib/services/functions_service.dart) → D 模組把 `functions/src/flows/*.ts` 從 stub 補完後刪除 TODO

切換到 live 模式前必須完成這兩件事，否則 UI 會看到 `HttpsError unimplemented`。

詳見 [113062210_chiajun.md 2026-05-27](./journal/113062210_chiajun.md) 那篇。

## 2026-05-27 — Cloud Functions region 改成 `asia-east1`（取代 `us-west1`）

Firestore database 開在 `asia-east1`（台灣），Cloud Functions region 跟著對齊：所有 `onCall` / `onRequest` / Firestore trigger / 排程一律 `asia-east1`。**不要混用 region**——混了 callable 在 Flutter 端會找不到，trigger 跨區也會增加 latency。

理由：團隊與 demo 觀眾都在台灣，課程範例用 `us-west1` 主要是因為 region 不重要、能跑就好；對齊 Firestore region 比沿用課程預設更實際（同 region trigger 寫入 ~10ms，跨太平洋 ~150ms）。

更動範圍（已實作）：
- `functions/src/admin.ts`：`REGION = 'asia-east1'`
- `lib/services/functions_service.dart`：`FirebaseFunctions.instanceFor(region: 'asia-east1')`
- `docs/ARCHITECTURE.md` §0 / §4 / §5（含 Cloud Tasks queue `--location=asia-east1`）
- `functions/src/triggers/scheduledDailyReport.ts`、`functions/README.md` 的指令字串

舊規矩留作歷史檔案：[`docs/journal/_index.md`](./journal/_index.md) 2026-05-26 那條「region 固定 us-west1」已不適用。

## 2026-05-26 — `commits` / `discordMessages` / `pullRequests` 必須冗餘存 `repoId`

Firestore `findNearest` 跨 collection group 搜尋時，必須 `where('repoId', '==', repoId)` 預過濾，否則跨 repo 資料洩漏。**寫入這三個 collection 時 repoId 不能漏**，即使路徑裡已經有了。

詳見 [`ARCHITECTURE.md §5.6`](./ARCHITECTURE.md#56-vector-search-索引與預過濾)。

## 2026-05-26 — `commits` / `pullRequests` / `discordMessages` / `dailyReports` / `members` Client 一律不能寫

Firestore Rules 對這 5 個 collection 設 `allow write: if false`，**只能透過 Cloud Functions (admin SDK 繞過 rules) 寫入**。
- 好處：webhook 來源驗證能徹底集中在 Function 裡，前端寫 bug 也不會污染資料
- 影響：若你想直接 Flutter 端寫，**請先停**——改成呼一個對應的 callable Function

## 2026-05-26 — Discord 長指令 (`gitsync-assign` / `gitsync-daily`) 必須走 Deferred Response

Discord Interactions Webhook 3 秒沒回應 = 「應用程式沒有回應」。AI flow 動輒 5–15 秒，**必須**：
1. 立刻 `res.json({ type: 5 })`（DEFERRED）
2. 背景跑完，PATCH `/webhooks/{appId}/{token}/messages/@original` 補結果

詳見 [`ARCHITECTURE.md §7.2`](./ARCHITECTURE.md#72-discordinteractions-function--3-秒回應限制--deferred-response)。

---

> 每加一條決策時，**同時**：
> 1. 寫日期 + 一句話標題
> 2. 寫理由（為何這樣決定）
> 3. 連到對應的 ARCHITECTURE / METHODS 章節
