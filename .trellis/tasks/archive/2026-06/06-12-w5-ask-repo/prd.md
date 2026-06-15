# W5 — 統一問答入口 askRepo + Agent 工具軌跡即時顯示

> Work item W5 (最後一項，整合 W1–W4)。對應 `docs/FINAL_DEMO_PLAN.md` §W5。
> UX 主軸：**「一個 agent 入口取代搜尋/篩選/分類頁 — 使用者只要學一個輸入框。」**
> **本階段：PLANNING ONLY，不改任何 source code。**

---

## Goal

1. **後端 A — `askRepo` flow + callable**：合併全部唯讀工具（commits / tasks / digests / past-commit 向量搜尋 / discord 向量搜尋 / repo 規劃文件 / 任務依賴 / roster）成單一「repo 全知助理」agentic 聊天。`MODELS.fast`、最多 5 輪、history ≤ 8 turns、projectBrief 當穩定前綴、答案附引用（commits + discord snippets，可選 tasks）。骨架直接 clone/extend `flows/dailyBriefChat.ts`。
2. **後端 B — agent 工具軌跡 side-channel**：flow 跑迴圈時，每輪 tool 執行後 best-effort 把進度行寫進 `apps/gitsync/repos/{repoId}/agentRuns/{runId}`。client 端在等待 callable resolve 期間 stream 這份 doc，逐行顯示「正在讀取 .trellis 進度… → 正在搜尋 commit…」。同樣套用到 `generateHandoffFlow` Phase-1。**軌跡寫入失敗永不影響 flow。**
3. **前端**：repo shell（四個 tab 都在）右下全域 FAB → 開啟 chat sheet，背後是新的 `AskRepoViewModel`（鏡像 `DailyBriefChatViewModel`：turns / ask() / sources）。等待時 stream agentRuns doc 即時渲染步驟標籤。既有兩個 tab 內聊天**不動**（只在「Out of scope / 後續」標註建議日後 migrate）。亮/暗模式都要。
4. **Fake mode**：canned askRepo 回應 + canned 軌跡步驟，讓 demo 離線可跑。
5. **i18n**：UI 字串走既有 `context.l10n` pattern；後端軌跡 label 是英文，前端原樣顯示。

---

## 現況核查（actual code vs spec）— 讀過實際 code 後的修正

讀完實際程式後對 spec 的關鍵修正/確認：

1. **`firestore.rules` 與 ARCHITECTURE.md §2.2 不一致（最重要）**：實際 `firestore.rules` 只有 wildcard dev 規則
   ```
   match /{document=**} { allow read, write: if request.time < timestamp.date(2026, 6, 25); }
   ```
   不是 ARCHITECTURE.md 文件裡那套 locked-down rules。**結論：client 端讀 `agentRuns/{runId}` 在現行部署規則下已被允許，demo（6/18）在到期日（6/25）之前，無須改 rules。** 這也吻合 `FINAL_DEMO_PLAN` 驗證清單：「Firestore rules 6/25 才到期，demo 不受影響；不要在 demo 前誤部署嚴格規則」。→ **本 task 不改 `firestore.rules`。** （見下方專節）
2. **`MODELS.fast` = `gpt-4o-mini`**（`config.ts`）。spec 寫「mini 模型」一致。
3. **沒有任何既有 `agentRuns` 參考**（grep 過 functions/src、lib、rules、indexes，零命中）→ 全新 collection，乾淨。
4. **`dailyBriefChat.ts` 骨架可直接複用**：system prompt + briefPrefix + history(≤8) + user，round loop（MAX_ROUNDS=4），surfaced commits dedupe by sha，超輪數強制收尾。askRepo 只需擴工具表 + 調 prompt + 加 snippets 收集 + 加 trace 呼叫。
5. **工具函式 signature 全部已存在、可直接 import**：
   - `dailyIntel.ts`：`listRangeCommits(repoId,start,end)`（`listDayCommits` 單日 wrapper）、`listRangeCompletedTasks`、`listRangeDigests`、`searchPastCommits(repoId,query,limit)` — 全 best-effort、回 []。
   - `discordSearch.ts`：`searchDiscordMessages(repoId,query,limit?,range?)` → `DiscordSnippet[]`；snippet dedupe 用 `discordChat.ts` 既有的 `snippetKey()` 邏輯（channelId:firstId:lastId）。
   - `repoDocs.ts`：`readRepoPlanningDocs(repoId)` → `{content,summary,source,...}`。
   - `assignTools.ts`：`getTaskDependents(repoId,taskId)`、`readTeamState(repoId)`。
   - `projectBrief.ts`：`readProjectBrief(repoId)` + `formatBriefForPrompt()`（empty → '' → byte-identical prefix）。
6. **callable 不能 stream**：`dailyBrief` callable 只在最後 resolve（return 整包）。所以軌跡必須走 Firestore side-channel，且 runId 必須在呼叫前就決定 → **client-generated runId 當 callable input**（見 trace 設計）。
7. **前端時段（range）**：dailyBrief/discordChat 有 range picker 概念，但 askRepo 是「全 repo 全時段」助理 → **不綁 range picker**；`listDayCommits`/`listCompletedTasks`/`listRangeDigests` 改用一個寬時段預設（見下方工具表 NOTE）。
8. **`generateHandoffFlow` 已是兩階段（W1）**：Phase-1 是 `for(;;)` 外圈 + `while(draft===null)` 內圈的 tool loop（`MODELS.reasoning`）。trace 加在「每批 tool 執行後」+「review verdict 後」，純 best-effort 插點，不動控制流。
9. **fake backend 是 singleton，無 Firestore**：`FakeFunctionsService` canned 回應；agentRuns 的 stream 在 fake mode 要由一個 `FakeAgentRunRepository` 吐 canned 步驟（不能讀真 Firestore）。
10. **flutter baseline 既有 2 個環境性 error**：`lib/firebase_options.dart`（gitignored、由 `flutterfire configure` 生成、本 worktree 缺）→ `main.dart` import 失敗，連帶 `widget_test.dart` 編不過。**這是環境基線，非 W5 引入；W5 不碰 main.dart，新增 widget test 不 import main.dart 即可避開。**

---

## Files to change（逐檔說明）

### 後端（functions/）

| # | 檔案 | 動作 | 說明 |
|---|---|---|---|
| 1 | `functions/src/flows/askRepo.ts` | **新檔** | clone `dailyBriefChat.ts` 骨架；8 個唯讀工具；MODELS.fast；MAX_ROUNDS=5；history≤8；projectBrief prefix；收集 commits(dedupe sha) + discord snippets(dedupe snippetKey)；每輪 tool 後呼叫 trace。input 多收一個 `runId?`。 |
| 2 | `functions/src/handlers/askRepo.ts` | **新檔** | 仿 `handlers/discordChat.ts`：`onCall({region,secrets:[openaiKey],timeoutSeconds:120})`，auth gate，驗 repoId/question，透傳 `runId`。 |
| 3 | `functions/src/prompts/askRepo.ts` | **新檔** | system prompt（仿 `prompts/dailyBrief.ts` 風格）：「你是這個 repo 的全知助理，回答進度/人/程式碼/討論的任何問題，一律 ground 在工具結果、附引用、用使用者的語言回答」。 |
| 4 | `functions/src/tools/agentTrace.ts` | **新檔** | trace side-channel helper：`startRun` / `appendStep` / `finishRun`，全 best-effort（try/catch + logger.warn，NEVER throw）。export 一個 step-label 常數表（英文）。 |
| 5 | `functions/src/flows/generateHandoff.ts` | **改（最小）** | Phase-1 每批 tool 執行後 + 每次 review verdict 後插一行 trace step。host flow 行為不變（trace 失敗吞掉）。runId 由 handler 透傳（手動 callable 可帶，trigger 路徑可不帶 → 無 runId 時 trace no-op）。 |
| 6 | `functions/src/index.ts` | **改** | 加 `export { askRepo } from './handlers/askRepo';`（Callables 區塊）。 |
| 7 | `functions/src/__tests__/askRepo.test.ts` | **新檔** | boundary-mock（仿 `dailyBriefChat.test.ts`）：fake Firestore + scripted OpenAI。 |
| 8 | `functions/src/__tests__/agentTrace.test.ts` | **新檔** | trace helper 單元測試：寫入 shape、best-effort 吞錯、無 runId 時 no-op。 |

> **不改**：`firestore.rules`（見專節）、`firestore.indexes.json`（agentRuns 單 doc by id，免複合索引）、既有工具檔（全直接 import）、`dailyBriefChat.ts` / `discordChat.ts`（兩 tab 聊天保持原狀）。

### 前端（lib/）

| # | 檔案 | 動作 | 說明 |
|---|---|---|---|
| 9 | `lib/models/ask_repo.dart` | **新檔** | `AskRepoTurn`（role/content/commitSources/discordSources/createdAt）、`AskRepoReply`（answer + commits[] + snippets[]）、source 子型別。可直接 reuse `DailyBriefSource` + `DiscordChatSnippet` 的 fromMap（或 re-export）。 |
| 10 | `lib/models/agent_run.dart` | **新檔** | `AgentRun`（runId/flow/status/steps[]/createdAt）、`AgentStep`（label/at）。`fromMap` 容忍缺欄位。 |
| 11 | `lib/view_models/ask_repo_vm.dart` | **新檔** | 鏡像 `DailyBriefChatViewModel`：turns / sending / error / ask() / newSession()。`ask()` 內：先 client-gen 一個 runId，開始 stream `AgentRunRepository.watch(repoId,runId)` → 即時更新 `liveSteps`，callable 回來後關 stream、append assistant turn（帶 sources）。 |
| 12 | `lib/repositories/agent_run_repo.dart` | **新檔** | `abstract AgentRunRepository { Stream<AgentRun?> watch(repoId,runId); }` + `_LiveAgentRunRepository`（Firestore doc snapshots）+ factory 切 fake。 |
| 13 | `lib/repositories/fake/fake_agent_run_repo.dart` | **新檔** | canned 步驟：每隔 simulatedLatency 吐一步（reading .trellis → searching commits → matching discord → composing），最後 status=done。 |
| 14 | `lib/services/functions_service.dart` | **改** | abstract 加 `Future<AskRepoReply> askRepo({repoId,question,history,runId})` + `_LiveFunctionsService` 實作（callable `askRepo`，透傳 runId）。 |
| 15 | `lib/services/fake/fake_functions_service.dart` | **改** | `FakeFunctionsService` 加 `askRepo`：keyword-match 既有 demo commits + discord（仿既有 dailyBrief/discordChat fake），回 canned answer + sources。 |
| 16 | `lib/views/shell/repo_shell.dart` | **改** | Scaffold 加 `floatingActionButton`（chat icon FAB），onPressed 開 `AskRepoSheet`（`showModalBottomSheet`，可全高/draggable）。亮暗模式用 `Theme.of(ctx).colorScheme`。 |
| 17 | `lib/views/ask/ask_repo_sheet.dart` | **新檔** | chat sheet UI：turns 列表（user/assistant 泡泡，仿 `_BriefTurnView`）+ sources 面板（commits + discord snippets）+ 等待時 live trace 步驟列 + 輸入列。 |
| 18 | `lib/router/app_router.dart` | **改** | ShellRoute 的 `MultiProvider` 加 `ChangeNotifierProvider(create: (_) => AskRepoViewModel(repoId: repoId))`，讓 FAB/sheet 全 tab 可讀同一個 VM。 |
| 19 | `lib/l10n/app_strings.dart` | **改** | 加 askRepo 相關字串 getter（`askRepoTitle`、`askRepoHint`、`askRepoSend`、`askRepoThinking`、`askRepoNewSession`、`askRepoSources` 等），每個 `_(en, zh)` 雙語。 |
| 20 | `lib/repositories/firestore_paths.dart` | **改** | 加 `agentRuns(repoId)` + `agentRun(repoId,runId)` path helper。 |
| 21 | `test/ask_repo_sheet_test.dart` | **新檔** | widget test（fake backend）：開 sheet → 送問題 → 等待時看到 trace 步驟 → 收到答案 + sources；new-session 清空。**不 import main.dart**（避開 firebase_options 基線問題）。 |

---

## askRepo 工具註冊表（OpenAI function-calling）

全部唯讀、全部 best-effort（底層工具失敗回 []/null）。flow 每輪平行執行 tool_calls，結果 `JSON.stringify` 餵回。

| Tool name (給 LLM) | 後端實作 | 參數 | 回傳（餵回 model） | 收集為 source? | trace label |
|---|---|---|---|---|---|
| `listDayCommits` | `listRangeCommits(repoId, since, today)` | `{}` | `DayCommit[]` | ✅ commits (dedupe sha) | `Listing recent commits…` |
| `listCompletedTasks` | `listRangeCompletedTasks(repoId, since, today)` | `{}` | `DayTask[]` | (可選 tasks) | `Listing completed tasks…` |
| `listRangeDigests` | `listRangeDigests(repoId, since, today)` | `{}` | `DaySummary[]` | — | `Reading Discord digests…` |
| `searchPastCommits` | `searchPastCommits(repoId, query, limit)` | `{query, limit?}` | `DayCommit[]`（向量優先） | ✅ commits (dedupe sha) | `Searching commit history…` |
| `searchDiscordMessages` | `searchDiscordMessages(repoId, query)` | `{query}` | `DiscordSnippet[]` | ✅ snippets (dedupe snippetKey) | `Searching Discord…` |
| `readRepoPlanningDocs` | `readRepoPlanningDocs(repoId)` → `.content` | `{}` | `string`（.trellis/AGENTS/docs） | — | `Reading .trellis planning docs…` |
| `getTaskDependents` | `getTaskDependents(repoId, taskId)` | `{taskId}` | `TaskDependent[]` | — | `Checking task dependents…` |
| `readTeamState` | `readTeamState(repoId)` → 投影 name/githubLogin | `{}` | roster（精簡） | — | `Reading team roster…` |

> **NOTE — 時段**：askRepo 是「全 repo 全時段」助理，不接 range picker。`since`/`today` 用一個寬預設窗（建議 `today` = 今天 Asia/Taipei，`since` = 今天往回 N 天，N 待拍板，建議 30）；跨時段問題交給 `searchPastCommits`（向量、全歷史）。→ **Open Question Q1**。
>
> **NOTE — 終止**：沿用 dailyBriefChat 收斂法（model 回無 tool_call 即答完；MAX_ROUNDS=5 後強制一輪 no-tools 收尾），不另設 finalize tool。

---

## Trace side-channel 設計

### Doc shape（`apps/gitsync/repos/{repoId}/agentRuns/{runId}`，一 run 一 doc）

```jsonc
{
  "flow": "askRepo",                  // 'askRepo' | 'generateHandoff'
  "status": "running",                // 'running' | 'done' | 'error'
  "steps": [                          // append-only，依時間排序
    { "label": "Reading .trellis planning docs…", "at": <serverTimestamp> },
    { "label": "Searching commit history…",        "at": <serverTimestamp> }
  ],
  "createdAt": <serverTimestamp>,     // flow 開始時 set
  "updatedAt": <serverTimestamp>      // 每次 append/finish set
}
```

### 寫入時機（write cadence）

- **flow 開始**：`startRun(repoId, runId, flow)` → `set({flow,status:'running',steps:[],createdAt,updatedAt})`。
- **每輪 tool 批次執行後**：對該輪每個 tool 呼叫，`appendStep(repoId, runId, label)`（用工具表的 label）。實作用 `FieldValue.arrayUnion` 或讀-改-寫皆可，但**為了即時性建議每步一次 `update({steps: arrayUnion(step), updatedAt})`**，讓 client 逐行看到。
  - 為避免單輪多工具造成多次 write，可把「該輪所有 tool label」合併成一次 `update`（一輪一 write）。→ **建議：一輪一次 batch update**（成本/即時性平衡；3–5 輪 → 3–5 writes）。
- **flow 結束**：`finishRun(repoId, runId, 'done'|'error')` → `update({status, updatedAt})`。
- **generateHandoff**：Phase-1 每批 tool 後 append；每次 review verdict 後 append（`Reviewing draft (score N/5)…`）；finalize 時 finishRun。

### runId handoff 設計（含 justify）

**選定：client-generated runId，當 callable input 傳進去。**

- **為什麼**：callable（`onCall`）只在 flow 跑完才 resolve 回 client；client 在等待期間什麼都拿不到。若 runId 由後端生成並只在 response 回傳，client 要等 callable 結束才知道 runId → 那時 trace 已沒意義（就是要 stream 等待過程）。所以 client 必須在**送出 callable 之前**就握有 runId，才能立刻訂閱 `agentRuns/{runId}` 的 doc stream。
- **怎麼生**：client 用 UUID v4（或 `DateTime.now().microsecondsSinceEpoch + nonce`）。後端把 runId 當「外部給定的 doc id」直接寫，不自己生。
- **替代方案與否決理由**：
  - (a) 後端預先 `agentRuns.doc()` 生 id 再用第二個 callable/stream 回傳 → 多一次往返、複雜、且仍有「callable 未回前拿不到 id」的本質問題。否決。
  - (b) 用 callable 的 `request.instanceIdToken` / 某個既有 id → 不穩定、不保證唯一、語意不符。否決。
  - (c) 不傳 runId、後端用 `(repoId, uid, 'latest')` 固定 doc → 同使用者並發兩個問答會互蓋。否決。
- **安全/驗證**：handler 驗 runId 格式（非空、長度上限、`[A-Za-z0-9_-]`），避免 path injection。無 runId（如 handoff 的 trigger 路徑）→ trace 整段 no-op（best-effort）。

### Trace 失敗永不影響 flow

`agentTrace.ts` 每個 export 包 try/catch + `logger.warn`，**NEVER throw**（Rule D 風格，同 `projectBrief.ts` / `repoDocs.ts`）。flow 內呼叫 trace 不 `await` 進主邏輯的成敗判斷（可 `await` 但結果忽略；或 fire-and-forget `.catch(()=>{})`）。**建議 await 但吞錯**，確保步驟順序與時間戳正確。

### Trace doc 保留策略（retention，justify）

**選定：留著、不主動清（leave）。** 理由：
- demo 只跑少量 run；agentRuns doc 極小（幾行 label），成本可忽略。
- 主動 keep-last-N 需要額外 query+delete 邏輯（成本/複雜度），且 wildcard rules 下沒有清理壓力。
- `FINAL_DEMO_PLAN` §不做範圍把 agent activity feed「降級為可選，資料源可直接用 agentRuns」→ 留著反而是日後 feed 的資料來源，有正面價值。
- **可選輕量收尾**（Open Question Q3）：finishRun 時也可 best-effort 刪同 repo 下 createdAt 超過 X 的舊 run；建議**先不做**，post-demo 再說。

---

## firestore.rules implications for agentRuns client reads

**核查實際檔案（`firestore.rules`）後的結論：**

- 目前部署的是 **wildcard dev 規則**：`match /{document=**} { allow read, write: if request.time < timestamp.date(2026, 6, 25); }`。
- 因此 client（已登入或甚至未驗證）**現在就能讀 `apps/gitsync/repos/{repoId}/agentRuns/{runId}`** — 不需要新增任何 rule。寫入只走 Cloud Functions（admin SDK 繞過 rules），client 不寫。
- ARCHITECTURE.md §2.2 描述的 locked-down rules（per-subcollection `allow read: if uid in memberIds`、`allow write: if false`）**尚未部署**。`FINAL_DEMO_PLAN` 驗證清單明確要求 demo 前不要部署嚴格規則（6/25 才到期）。
- **本 task 不改 `firestore.rules`。** 但**在 prd 留警示**：若日後（post-demo）部署 locked-down rules，必須補一條 agentRuns 的 client-read rule：
  ```javascript
  // 與其他唯讀 subcollection 同形：member 可讀、client 不可寫
  match /agentRuns/{runId} {
    allow read: if request.auth != null
                && request.auth.uid in get(/databases/$(database)/documents/apps/gitsync/repos/$(repoId)).data.memberIds;
    allow write: if false;
  }
  ```
  → 列入 **Open Question Q2 / Out-of-scope（post-demo）**，由 orchestrator 決定是否現在就把這條寫進文件版 rules（不部署）。

---

## VM / Page / Widget 結構（前端）

```
RepoShell (Scaffold)
 └─ floatingActionButton: chat FAB  ──tap──► showModalBottomSheet → AskRepoSheet
        (provider scope: 用 ShellRoute 的 MultiProvider 已提供的 AskRepoViewModel)

AskRepoViewModel (ChangeNotifier)               // 鏡像 DailyBriefChatViewModel
 ├─ List<AskRepoTurn> turns
 ├─ bool sending / String? error
 ├─ List<AgentStep> liveSteps                   // 等待期間的即時軌跡
 ├─ ask(question):
 │    1. runId = uuid()
 │    2. history = snapshot(turns) (≤8 後端再裁)
 │    3. add user turn; sending=true; liveSteps=[]; notify
 │    4. sub = AgentRunRepository.watch(repoId,runId).listen((run){ liveSteps = run.steps; notify; })
 │    5. reply = functions.askRepo(repoId, question, history, runId)
 │    6. sub.cancel(); add assistant turn(reply.answer, commits, snippets); sending=false; notify
 │    (catch → error + 道歉 assistant turn；finally sending=false, sub.cancel)
 └─ newSession(): 清 turns/error/liveSteps（sending 中 no-op）

AskRepoSheet (StatelessWidget / 小 StatefulWidget)
 ├─ header（title + new-session button）
 ├─ Expanded ListView：turns → _AskTurnView（user/assistant 泡泡）
 │     assistant turn 下方：_CommitSourcesPanel + _DiscordSourcesPanel（reuse 既有面板樣式）
 ├─ sending 時：_LiveTraceStrip（逐行顯示 liveSteps 的 label，最後一行帶 spinner）
 └─ _InputBar（TextField + send）
```

亮暗模式：所有顏色走 `Theme.of(ctx).colorScheme`（primary/surface/onSurfaceVariant…），泡泡/面板比照 `daily_view_page.dart` 既有 `_BriefTurnView`/`_BriefSourcesPanel` 寫法（已雙模式安全）。

---

## Fake-mode 設計

- `AppConfig.useFakeBackend` 同一開關決定 `FunctionsService` 與 `AgentRunRepository` 走 fake。
- **`FakeFunctionsService.askRepo`**：仿既有 `dailyBrief`/`discordChat` fake — keyword-match `DummyData.commits` + `DummyData.discordMessages`，回 canned `AskRepoReply`（answer + commit sources + discord snippets），delay `simulatedLatency * 3`。
- **`FakeAgentRunRepository.watch(repoId,runId)`**：回一個 `Stream<AgentRun?>`，每 `simulatedLatency` 吐一步（canned 步驟序列：`Reading .trellis planning docs…` → `Searching commit history…` → `Searching Discord…` → `Composing answer…`），最後 `status:'done'`。讓離線 demo 也看得到軌跡逐行浮現。
- fake `askRepo` 的 delay 要 ≥ fake trace 吐完所有步驟的時間，確保 sheet 上「先看到軌跡、後出答案」的觀感。

---

## Test plan

### 後端（jest + ts-jest，boundary-mock，仿 `dailyBriefChat.test.ts`）

`functions/src/__tests__/askRepo.test.ts`：
1. 無 tool_call → 直接回答（answer pass-through，commits/snippets 空）。
2. 一輪 `listDayCommits` → 收集 commits 並 dedupe sha。
3. `searchDiscordMessages` → snippets 收集並 dedupe snippetKey。
4. 多輪混合工具 → sources 聚合正確、順序 first-seen。
5. 超過 MAX_ROUNDS=5 → 強制 no-tools 收尾、仍回 answer。
6. projectBrief 有內容時 system prefix 含 brief；空 brief → 不變。
7. trace：傳 runId 時 startRun/appendStep/finishRun 有被呼叫（mock agentTrace）；不傳 runId → trace no-op，flow 結果不變。
8. trace 寫入 throw 時被吞掉，flow 仍正常回答（best-effort 不擋）。

`functions/src/__tests__/agentTrace.test.ts`：
1. `startRun` 寫 `{flow,status:'running',steps:[],createdAt}`。
2. `appendStep` 累加 step（含 label + at）。
3. `finishRun` 改 status。
4. 任一寫入 throw → 吞掉、不 rethrow（NEVER throw）。
5. 無 runId（空/非法）→ no-op。

`generateHandoff.test.ts`：**既有測試需保持綠**（加 trace 是 best-effort 插點，不改 host 行為）；mock agentTrace 為 no-op，確認既有 assertion 不破。視需要加 1 個「Phase-1 有呼叫 appendStep」的測試。

### 前端（flutter widget test，fake backend）

`test/ask_repo_sheet_test.dart`（**不 import main.dart / firebase_options**）：
1. pump 一個含 `AskRepoViewModel`(fake) + `FakeAgentRunRepository` 的最小 widget tree → 開 sheet。
2. 輸入問題、送出 → 等待期間 `_LiveTraceStrip` 顯示 canned 軌跡步驟（至少出現第一步 label）。
3. callable 回來 → assistant 泡泡出現、sources 面板渲染 commit + discord snippet。
4. new-session 按鈕清空 turns（仿既有 `daily_discord_tab_test.dart` 的 new-session 測試）。
5. 亮/暗模式各 pump 一次（`MaterialApp(theme/darkTheme + themeMode)`）confirm 不 crash（樣式 smoke）。

> baseline 既有的 `widget_test.dart` 失敗（缺 firebase_options.dart）**不在本 task 修復範圍**（環境性）；新增 widget test 自帶最小 tree、不觸發該 import。

---

## Out of Scope

- **既有兩 tab 內聊天（dailyBrief / discordChat）migrate 到 askRepo**：spec 明確「保留 UI 位置、建議日後統一」。本 task 只新增全域入口，不動兩 tab 聊天後端/前端。（建議日後 follow-up task。）
- **改 `firestore.rules` 成 locked-down + 補 agentRuns read rule**：post-demo（6/25 後）才需要；現行 wildcard 已允許。本 task 只在 prd 留好該補的 rule 片段。
- **agentRuns retention/清理排程**：留著不清（見 retention 設計）。
- **Agent activity feed 頁面**：`FINAL_DEMO_PLAN` 降級為可選；本 task 只產生 agentRuns 資料，不做 feed UI。
- **askRepo 綁 range picker**：askRepo 是全時段助理，不接時段 UI。
- **handoff trigger 路徑帶 runId**：trigger（onTaskUpdated）無 client，不傳 runId → trace no-op；只有手動 callable / askRepo 有即時軌跡。
- **i18n 後端軌跡 label 翻譯**：label 是英文常數，前端原樣顯示（spec 指定）。

---

## Risks

1. **即時性 vs 寫入成本**：每步一次 Firestore write 最即時但 write 多；折衷「一輪一 write」。風險低（3–5 輪）。→ 設計選一輪一 batch update。
2. **runId 訂閱與 callable 競態**：若 callable 比第一筆 trace 還快回（fake mode 尤甚）→ liveSteps 可能空。緩解：fake askRepo delay ≥ trace 吐完；live 模式 OpenAI 往返遠慢於首筆 write，自然無虞。
3. **fake mode 沒有真 Firestore**：必須走 `FakeAgentRunRepository`，否則 stream 會打真 Firestore（fake 模式無 Firebase init）→ 一定要由 factory 切 fake。
4. **generateHandoff 既有測試**：加 trace 若不小心改了控制流會破 W1 的 jest。緩解：trace 純插點 + mock no-op + 跑全 suite 驗證 288→ 維持綠。
5. **provider scope**：FAB 在 RepoShell（ShellRoute child 外層），AskRepoViewModel 必須提供在 ShellRoute 的 MultiProvider（已是所有 per-repo VM 的提供點）→ FAB 與 sheet 都讀得到。
6. **firebase_options 基線**：新 widget test 若誤 import main.dart 會連帶失敗；明確要求自帶最小 tree。

---

## Open Questions（已由 orchestrator / Fable 5 拍板 — RESOLVED）

- **Q1（時段預設）— RESOLVED**：三個 day-scoped 工具（`listDayCommits`/`listCompletedTasks`/`listRangeDigests`）的 OpenAI schema 都加一個可選 `days` 參數（**default 30，hard cap 92**），讓 model 自選窗寬；全時段語意查詢仍走 `searchPastCommits` / `searchDiscordMessages`。實作：`flows/askRepo.ts` `clampDays()`（`[1,92]`，預設 30）+ `sinceKey(days)`（Asia/Taipei）。
- **Q2（rules 文件版）— RESOLVED**：**只留在 prd，不碰 `firestore.rules`**。wildcard dev rules 撐到 demo 後（6/25）才換；下方 §"firestore.rules implications" 的 locked-down agentRuns snippet 保留為 post-demo 文件，本 task 不寫進 rules、不部署。
- **Q3（retention）— RESOLVED**：**確認留著不清**。agentRuns docs 不做 pruning/retention；post-demo cleanup 列入 Out-of-scope。
- **Q4（FAB 顯示範圍）— RESOLVED**：FAB 在 repo shell **所有 tab（含 settings）全顯示**。實作：FAB 掛在 `RepoShell` 的 `Scaffold.floatingActionButton`（在四個 tab 共用的 shell 上），自然覆蓋全部 tab。
- **Q5（tasks 當 source）— RESOLVED**：sources 面板**只顯示 commits + discord snippets**；model 答案文字仍可提及 tasks，但不進 source 面板。實作：`AskRepoReply` 只帶 `commits` + `snippets`。
- **Q6（FAB icon / 文案）— RESOLVED**：FAB icon = `Icons.auto_awesome`；l10n title = en "Ask GitSync" / zh "問 GitSync"（`askRepoTitle`）。

---

## Baseline（實作前已驗證，本分支 `feat/w5-ask-repo`，worktree clean）

- **後端**：`npm run typecheck` → 0 errors；`npm test` → **35 suites / 288 tests** green。
- **前端**：`flutter analyze` → **3 issues（全部 pre-existing / 環境性）**：2 個 error 是缺 gitignored `lib/firebase_options.dart`（`main.dart` import + `DefaultFirebaseOptions`），1 個 info 是 `user_repo.dart:78` null-aware 建議。**皆非 W5 引入。**
- **前端 test**：`flutter test` → **78 pass / 1 fail**；唯一 fail 是 `widget_test.dart`（預設 counter smoke test）因缺 `firebase_options.dart` 編不過 → 環境基線，非程式回歸。所有 feature/widget 測試（daily summary/discord tab、commits tree…）全綠。
