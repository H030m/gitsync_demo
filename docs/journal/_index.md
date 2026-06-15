# 團隊近 7 天動態 (Index)

> 這份檔案由每位 AI / 人在寫完日誌後**自行更新**。最新動態在最上面，超過 7 天的條目自動下移到「歷史」區塊（或直接刪除——repo 有 git 紀錄）。
>
> 開工前必讀。看到「進行中」欄裡有別人正在動的檔案，請避開或先協調。

---

## 進行中（aka 不要碰）

| 隊員 | 在做什麼 | 預計動的檔案 |
|---|---|---|
| 嘉駿（多代理） | **Final demo 衝刺 W1–W5**（計畫見 [`docs/FINAL_DEMO_PLAN.md`](../FINAL_DEMO_PLAN.md)；分支 `feature/agentic-final-demo` ← `feat/w1`~`feat/w5`，全部從 develop 出，不碰既有分支） | `functions/src/flows/{generateHandoff,summarizeDay,assignTask}.ts`、`functions/src/tools/{discordSearch,dailyIntel,embedding}.ts` + 新 `repoDocs.ts`、`functions/src/triggers/onDiscordMessageCreated.ts`、新 `flows/askRepo.ts`、`functions/src/index.ts`、W5 前端聊天入口 |
| 嘉駿 | Discord 整合（模組 B）| `discord-bot/`、`functions/src/handlers/discordMessageIngest.ts` |

> 嘉駿剛把骨架鋪完（Sprint 1）。**接下來各模組隊員就 [`ARCHITECTURE.md §9`](../ARCHITECTURE.md#9-模組職責--隊員分工建議) 開工**，避免動到別人的層；如要跨層改動先在這列出。

---

## 2026-06-12

- **嘉駿 — Final demo 衝刺【完工】：W1–W5 全部合入 `feature/agentic-final-demo`（@`cee696c`，已 push）**：① W1 交接文件升級兩階段 agentic（gpt-4o 工具循環含**新 getCommitDiff**＋gpt-4o-mini self-review 打分迴圈、`handoffReview` 存 task doc）；② W2 語意搜尋（Discord embedding 補上、commit/Discord 搜尋向量優先＋關鍵字兜底、`backfillEmbeddings` callable）；③ W3 專案記憶（`meta/projectBrief` 滾動簡報餵所有 flow＋指派 `learnedTags` 寫回 `users/{uid}.expertiseTags`）；④ W4 `readRepoPlanningDocs`（agent 讀 repo 的 `.trellis`/AGENTS/CLAUDE，接進 breakdown）；⑤ W5 `askRepo` 統一問答 callable＋`agentRuns` 工具軌跡 side-channel＋全 tab「Ask GitSync」FAB（live 顯示 agent 工具呼叫、亮暗模式、fake 模式可跑）。整合 gate：functions jest **310/310**、typecheck/lint 0；flutter analyze 0 新增、test 85 過（1 失敗為既有環境問題）。五個 trellis task 已 archive。**Demo 前待辦（人工）**：deploy functions＋indexes、對演示 repo 跑 backfill、確認 `.trellis` 內容可投影。**develop→main 大 PR 落地後**才開 integration→develop 的 PR。
- **嘉駿 — Final demo 衝刺開工（W1–W5 計畫定案 + 多代理分工）**：對照評分標準定案五個工作項——W1 agentic 交接文件（工具循環＋self-review）、W2 語意搜尋強化（Discord embedding 補 stub＋向量優先＋backfill）、W3 專案記憶（滾動 projectBrief＋expertiseTags 寫回）、W4 讀 repo 的 `.trellis`/`AGENTS.md` 工具、W5 統一問答入口 `askRepo`＋工具軌跡顯示。完整計畫與 3 分鐘 demo 腳本見 [`docs/FINAL_DEMO_PLAN.md`](../FINAL_DEMO_PLAN.md)。分支：`feature/agentic-final-demo`（整合）← `feat/w2-semantic-search`、`feat/w4-repo-docs`、`feat/w1-agentic-handoff`、`feat/w3-project-memory`、`feat/w5-ask-repo`，全從 develop @ `92f858a` 出。FCM 由廷煥的分支完成，本批不碰。
## 2026-06-13

- **嘉駿 — 三個前景 AI flow 改真 agentic + live 工具軌跡（分支 `feat/agent-trace-fanout`）**：把交接文件的 `agentRuns` 思考軌跡 fan-out 給三個前景 flow。① `discordChat`（已 agentic）只接 trace；② `explainCommit` 單次→工具迴圈，agent 自撈 `searchDiscordMessages`/`listNeighborCommits`/`getCommitDiff`→`writeExplanation`（**commit 解釋會引用相關 Discord 討論**，保留 workSummary 快取＋GitHub fallback）；③ `editDiscordDigest` 單次→工具迴圈，agent 撈當天原始訊息/鄰近日 digest→`writeDigest`（**摘要改寫有所本**，維持 lock，bot bridge 路徑無 trace）。共用 `AgentTraceMixin`＋復用 `AskRepoLiveTraceStrip`；runId 前綴 `handoff-`/`chat-`/`explain-`/`editdigest-`。背景 `discordDailyDigest` 刻意不改。gate：functions jest **322/322**、tsc 0；flutter analyze 0 新增、test **98/98**。**尚未 deploy**；trace 文字仍固定英文。四個 trellis `06-13-{agent-trace-fanout,discord-chat-trace,explain-commit-agentic,edit-digest-agentic}` done。詳見 [113062210_chiajun.md](./113062210_chiajun.md)。
- **嘉駿 — Ask GitSync 實機回饋修正（commit 時間＋分群視窗＋時效性）**：① 來源 commit 卡片加提交時間（精確到小時）——`DayCommit.committedAt` 一路打通到前端 `DailyBriefSource`；② 取代「永遠 12」——`askRepo` 改 agent 驅動分群，`listDayCommits` 加可選 `authorLogin`/`taskId`（TS in-memory 過濾，**不加 composite index**），每次過濾呼叫成一個帶標籤 window，回新 `commitGroups`（保留扁平 `commits` 相容），前端每群一個面板；③ prompt 加規則：整體問題依人/任務多呼叫、時效性問題先依時間排序、**不得對使用者講顯示上限**。分群維度由 agent 依問題自選。functions jest 320/320、tsc 0；flutter analyze 0 新增、相關 widget/vm 測試全綠。trellis `06-13-ask-repo-commit-windows`，分支 `feature/agentic-final-demo`。詳見 [113062210_chiajun.md](./113062210_chiajun.md)。
- **廷煥 — 任務狀態編輯雙入口**：收合清單驗收時發現詳情頁狀態 chip 從來都是唯讀、手機只能「→完成」。新增共用 `showStatusPicker` bottom sheet，雙入口：詳情頁主任務 chip 可點、清單列長按；相關任務 chip 維持唯讀、既有行為不變。測試 85/85（新建 task_details 測試 harness）。trellis `06-13-task-status-editor`，同分支 `feature/mobile-board-sections`。
- **廷煥 — Tasks 看板手機版重設計（收合式三段清單）**：手機寬度從「三條 200dp 欄橫向捲動」改為 TickTick 風格垂直收合清單（待辦/進行中/完成 header + 數量、AnimatedSize 展開收合、預設完成區收起）；任務列點擊進詳情、**圓圈勾選直接標完成**（直達 done→AI 分派→FCM 推播的 demo 鏈路）。寬螢幕 kanban 不動。順手清掉 temmie 06-12 遺留的 2 個紅測試並新增 5 個清單測試——**全套 81/81 綠**。trellis `06-13-mobile-board-sections`，分支 `feature/mobile-board-sections`。詳見 [113062340_tinghuan.md](./113062340_tinghuan.md)。

## 2026-06-12

- **廷煥 — FCM live e2e 全過、PR #38 併入 main，06-03 收工**：環境補齊（flutterfire configure + SHA 登記）後在 Android emulator live mode 完整驗證：fcmToken 寫入 ✓、done→自動通知下游（前景重畫/背景推播/點擊導頁）✓、per-locale 繁中推播文案 ✓、權限拒絕 SnackBar 提示 ✓。併入 develop 零衝突、analyze/test 全綠。**經隊友同意 PR #38 直接合入 main**。⚠️ 待辦：main 需 back-merge 回 develop（目前 develop 沒有 FCM 工作，兩分支分岔 9 vs 7）；另發現後端既有 bug `summarizeDay` 回 internal（與通知無關，owner 請查 cloud log）。詳見 [113062340_tinghuan.md](./113062340_tinghuan.md)。

## 2026-06-10

- **廷煥 — 接手 FCM 通知 task、修權限被拒的靜默失敗**：經嘉駿同意接手 `06-03-wire-fcm-notifications`（assignee → smartalan91，分支沿用 `feature/foreground-notifications`）。乾淨環境重現「測試通知按了沒彈」→ 重現不出來（code 是好的）；實測證實根因候選之一：**通知權限被拒後按按鈕完全靜默**。修補：`ensurePermission()`（被拒先 re-prompt 一次）+ SnackBar 提示（l10n en/zh）；FCM `onMessage` 被動重畫刻意維持靜默。模擬器雙路徑實測通過、analyze 0 warn、test 79/79。lesson 沉澱至 spec（通知權限回饋慣例、`google-services.json` 佔位檔解法 → SETUP §5.10）。**待辦**：live FCM 端到端（環境未備）、併回 develop（settings_page 預期衝突）。詳見 [113062340_tinghuan.md](./113062340_tinghuan.md)。
- **嘉駿 — Android 上機 live + GitHub 登入修復 + 前景通知（demo）**：app 首次在 Android 模擬器連雲端 Firebase 跑起來。**fix(auth)**：`signInWithProvider` 在 Android 回傳基底 `AuthCredential`，原 `as OAuthCredential?` 硬轉閃退 → 改 `is` 守衛（已 commit `30f929e`；後續 `accessToken` 多為 null，需 GitHub token 的功能待另案）。**fix(ui)**：Daily Contributions chip 在 label 是 raw UID 時 overflow → 名字限寬 + ellipsis（根因 report 缺 `githubLogin`/`displayName`，名字解析待另案）。**feat(notifications)**：前景 FCM 改用 `flutter_local_notifications` 彈可見系統通知（原只 `debugPrint`）+ Settings「傳送測試通知」demo 鈕 + Android core library desugaring；延續 `06-03-wire-fcm-notifications`。**docs(readme)**：Live 模式加 debug SHA 指紋登記步驟（每台機器各自登記，否則 GitHub 登入撞 `invalid-cert-hash`）。gate：analyze 改動檔 0 error、flutter test **79/79**、build apk 成功。分支 `feature/foreground-notifications`。
## 2026-06-04

- **Bugfix：Commits tab 無限轉圈（webhook commit schema 跨層不一致）**：live 模式 Commits tab 永遠在 loading。根因是 `githubWebhook` 寫進 Firestore 的型別跟下游全部對不上 —— `committedAt` 寫 **ISO 字串**（Flutter `as Timestamp?` cast 丟例外 → stream error → VM 沒接 `onError` → spinner 卡死；且字串永遠 match 不到後端 `listRangeCommits`/Flutter `streamRange` 的 Timestamp 範圍查詢，**範圍日報會漏掉這些 commits**）、`filesChanged` 寫**數字**（Flutter 期待路徑陣列、`explainCommit` 也吃陣列）。修三層：(1) webhook 改寫 `committedAt: Timestamp`（ISO 解析失敗 fallback serverTimestamp）、`filesChanged: [...added,...removed,...modified]`；(2) Flutter `Commit.fromMap` 防禦性解析（容忍舊字串/數字形狀，救回既有壞 doc 的顯示）；(3) `CommitsViewModel` 補 `onError` + `streamError`/`retry()`，UI 加錯誤狀態與 Retry 鈕。**既有 prod 壞 doc** 需人工跑一次 [`functions/scripts/normalize-commits.mjs`](../../functions/scripts/normalize-commits.mjs)（支援 `--dry-run`；需 ADC 憑證），否則範圍查詢仍看不到舊 commits。webhook 修正本身也**尚未 deploy**。gate 全綠（functions jest 138/138、flutter test 20/20 含新回歸測試、analyze 0 error）。
- **Summary 時段報告 + Commit Tree 地圖（點擊 AI 總結）**：情報總站第二輪。Summary tab 加 **range picker**（預設今天、上限 92 天）— `summarizeDayFlow` 改收 `{startDate,endDate}`，工具換成 `listRangeDigests`（時段內逐日 digest）＋`listRangeDiscordMessages`（raw 兜底 cap 500）；跨日報告存 `dailyReports/{start}_{end}`；「問 AI」聊天同步時段（`dailyBrief` 加 `endDate`）。Commits tab 重建成 **commit tree 地圖**（lane-per-author CustomPaint、日期分隔、可滑動、range 篩選 via `CommitRepository.streamRange`），**點 commit 開 bottom sheet → 新 `explainCommit` callable 產 AI 工作總結**（linked tasks + 同作者鄰近 commits grounding；cache 在 `commits/{sha}.workSummary`，重複點零成本）。`firestore.indexes.json` 補 tasks `status+updatedAt` 複合索引。dummy commits 補 staggered `committedAt` + 兩筆新 commit 讓 tree demo 有三天三 lane。gate 全綠（functions jest 137/137、flutter analyze 0 error、flutter test 含 tree 渲染/點擊/範圍篩選 widget 測試）。trellis `06-04-summary-range-tree`。
- **Summary「開發者每日情報總站」整段完工（agentic 日報 + commit 訊息整理 + 問 AI 今天）**：把 Summary tab 從空殼做成情報總站。後端 `summarizeDayFlow` 從「非 Agentic 單次」升級成 **agentic function-calling loop**（工具 `getDayDigest`/`searchPastCommits`/`finalizeReport`；當日 commits/tasks/roster 先純 TS 抓好、`computeContributions` 用 `author.login→userId` 精確計數，不交給 LLM 數），產出 summary/highlights/blockers/**commitThemes（commit 訊息整理）**/memberContributions 寫 `dailyReports/{date}`，沒繳交則 deterministic fallback。新增 **`dailyBrief` callable + `dailyBriefChatFlow`**（仿 discordChat 的 agentic 聊天，4 個唯讀工具，回傳答案 + 來源 commits）。`scheduledDailyReport` 補完扇出：改用 `firebase-admin/functions` `taskQueue().enqueue()`，`dailyReportWorker` 轉 **`onTaskDispatched`**（queue 隨函式自建、自帶 retry、**不加** `@google-cloud/tasks` 依賴）。前端 `DailyReport` model 擴欄、新 `daily_brief` models + `DailyBriefChatViewModel`，`_SummaryTab` 重建（日報卡＋重點/阻礙＋commit rollup＋貢獻 chips＋釘在底部的「問 AI 今天」聊天＋來源面板），dummy data 補新欄位 + fake `dailyBrief`。gate 全綠（**functions jest 131/131**、**flutter analyze 0 error**、**flutter test 12/12** 含 Summary tab 渲染 + 聊天的 widget 測試）。**尚未 `firebase deploy`**。trellis `06-03-summary-intel-hub`，分支 `feature/summary-intel-hub`。詳見 [`ARCHITECTURE §5.4`](../ARCHITECTURE.md) / [`AGENTIC_CONCEPTS §7`](../AGENTIC_CONCEPTS.md)。

## 2026-06-03

- **嘉駿 — Discord 大改版（AI 聊天框 + digest 收合/鎖定/AI 改寫 + 範圍雙 cursor + 分組 snippet）**：Daily→Discord 下半部改成**與 AI 對話的聊天框**（新 callable `discordChat`，agentic loop；工具 `listDaySummaries`/`getDaySummary` 讀逐日 digest 省 context、`searchDiscordMessages` 搜原始訊息）。digest 卡片可**收合**、加**鎖定**（鎖住擋掉所有自動覆寫，存 `discordDigests/{date}.locked`）、卡內「叫 AI 改寫」欄 + Discord `/gitsync-digest` 指令（`editDiscordDigest`/`setDigestLock`/`botEditDigest`）。回補改成 **`[start,end]` 範圍雙 cursor**（low=`snowflake(start)`、high=`snowflakeForTaipeiDayEnd(end)` exclusive），`setDiscordRange` 寫範圍 + reset watermark + **prune**（刪範圍外訊息/日報），`discordRangeDigestFlow` 對範圍內**每天各產 digest**（空白/鎖定/未變動跳過，上限 92 天）。related message 改成**分組對話 snippet**（命中±2 同頻道上下文、`isMatch` 標記、divider 分隔）。Refresh 改成等 `fetchRequests/{id}.status` terminal 才停、跳 `Updated ✓`。**仍是關鍵字比對（非語意；訊息未做 embedding）、且全部尚未 `firebase deploy`**。四個 trellis 工作皆 archive，分支 `feature/discord-range-cursor` 已 push。gate 全綠（functions jest 121/121、flutter analyze/test、bot build）。詳見 [113062210_chiajun.md](./113062210_chiajun.md) / [`ARCHITECTURE §7`](../ARCHITECTURE.md)。
- **嘉駿 — Discord on-demand ingest 收尾 + 部署/環境開關**：補完 PR3（Daily→Discord refresh 按鈕、AI digest 卡片、`requestDiscordFetch` 串接；修兩次 partial commit 讓 develop 重新可編譯）。新增統一 `TARGET=cloud|emulator` 開關，讓 app（`--dart-define=TARGET`）與 bot（`.env` `TARGET`）一起切後端（main.dart 導向 emulator；bot 由 `TARGET`+`FIREBASE_PROJECT_ID` 自動推 URL）。新增 [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md) 雲端部署 runbook（含錯誤對照表）。實機 live 排錯：`bad secret`（Secret Manager 值與 bot 不符 → 修並 redeploy）；`claimDiscordFetch` 500 = `fetchRequests` 複合索引未部署（`firebase deploy --only firestore:indexes` 後 Enabled 即解）。三 gate 全綠。詳見 [`ARCHITECTURE §7`](../ARCHITECTURE.md) / [`DEPLOYMENT.md`](../DEPLOYMENT.md)。

## 2026-06-02

- **嘉駿 — Discord bot 上線 + 接收 probe**：建好 Discord application（Guild Install、唯讀權限、開 Message Content Intent）並邀請進伺服器；新增 `discord-bot/src/probe.ts`（只需 token 的連通性探針，`npm run probe`）。實測 probe 登入成功並收到 DC 訊息印在 terminal（`#幹話`/`#會議記錄` 中文內容正確）。端到端 ingest（bot→Function→Firestore）尚未測，trellis 工作 `06-02-discord-bot-live-setup` 仍 in_progress。詳見 [113062210_chiajun.md](./113062210_chiajun.md)。
- **嘉駿 — Discord forwarder bot + ingest 完工**：新建 `discord-bot/`（discord.js v14 TS 套件，抓 mapped channel 訊息→第一道過濾→指數退避 POST）+ 補完 `discordMessageIngest` Cloud Function（驗 payload→第二道過濾→`create()` 原子寫入兼 messageId 去重）。雙層過濾 + 去重防垃圾塞爆。typecheck/build 0 error、filter smoke test 12/12。`onDiscordMessageCreated`（embedding/AI 連 task）仍 stub。詳見 [113062210_chiajun.md](./113062210_chiajun.md) 2026-06-02 那篇。

## 2026-05-27

- **嘉駿 — Fake backend 模式上線**：`--dart-define=BACKEND=fake` 切換；Repository / AuthService / FunctionsService 全部 abstract + Live + Fake；UI 不需要 Firebase / OpenAI / GitHub 就能跑。Region 同步從 us-west1 改 asia-east1（對齊 Firestore 台灣 region）。詳見 [113062210_chiajun.md](./113062210_chiajun.md) 2026-05-27 那篇。

## 2026-05-26

- **嘉駿 (113062210) — Sprint 1 骨架完工**：lib/ 五層 MVVM (theme/models×9/repositories×9/services×5/view_models×8/router/views×11/main.dart) + functions/ TS (handlers×12, triggers×7, flows×4, prompts×4, tools×5, services×1, config/types/admin/index) + secrets/ 中央倉 (含 README + *.env.example) + firestore.rules / indexes / firebase.json。`flutter analyze` 0 warn、`tsc --noEmit` 0 error。**所有 flow 是 stub**（`throw new Error('not implemented yet')`），各模組隊員只要往對應檔案補 OpenAI 呼叫即可。詳見 [113062210_chiajun.md](./113062210_chiajun.md) 2026-05-26 16:50 那篇。
- 初始化專案文件結構，建立 `docs/journal/` 與五人 journal 初始檔。
- 架構師 review pass：併發守則 (§4.4)、排程扇出 (§5.4)、commit filter (§5.6)、Discord 簡化為「訊息直寫 Firestore」(§7) — 全數寫入 ARCHITECTURE.md + MEMORY.md。
- 第二輪 review：補強 §4.4 Rule C（trigger at-least-once → in-trigger idempotency 強制）、§7 forwarder + ingest 雙層 Discord 訊息過濾、§10 Sprint 4 與簡化版 Discord 對齊。
- 第三輪 review：§5.1 breakdownTask 分散式鎖（isBreakingDown + 兜底排程）、§6.3 ↔ §4.3 職責切分（webhook 只寫 raw，trigger 才做 AI）、§7.2 forwarder 指數退避 retry、§11 風險表全面更新。
- 第四輪 review（docs/issue.txt）：§5.1 補 Step 4-6 索引→taskId 翻譯、§5.6 補 tasks.dependsOn array-contains 複合索引、§2.1 users 加 discordUserId 欄位、§5.2/§5.3 tool 餵 AI 三組身份對照。
- 文體規範：ARCHITECTURE.md 內所有 TS/Dart 實作 code 改寫為敘述（§4.4、§5.1、§5.4、§5.6、§6.3、§6.4、§7.2、§7.3、§12）。保留 code 的例外：顏色、Firestore Rules、部署指令、設定檔、ASCII 圖、schema tree。詳見 MEMORY.md。

---

## 歷史（> 7 天）

_（之後超過 7 天的條目搬到這裡，或刪掉——git log 留得住）_
