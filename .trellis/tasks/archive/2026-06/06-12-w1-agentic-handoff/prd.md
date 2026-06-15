# W1 — 交接文件升級為 Agentic（Two-Phase Handoff）

> 對應 [`docs/FINAL_DEMO_PLAN.md`](../../../docs/FINAL_DEMO_PLAN.md) **W1**。
> 分支 `feat/w1-agentic-handoff`，worktree `ssfinal/gitsync-w1`，base `feature/agentic-final-demo`（已含 W2 vector-first search、W4 readRepoPlanningDocs）。
> **本文件為計畫；實作前須經 Fable 5 review 放行（PLANNING PHASE ONLY，尚未改任何 source）。**

---

## Goal

把 `generateHandoffFlow` 從「確定性預取 + 一次 `gpt-4o-mini` 呼叫、無工具、無審查」升級為**兩階段 agentic**，兌現期中投影片核心功能 03 的兩個承諾：

1. **自主檢索**——agent 自己決定要不要讀某 commit 的 diff、翻哪段 Discord、讀 repo 的 `.trellis` 規劃文件（Phase 1 工具循環，`gpt-4o`）。
2. **自我審查**——一個 `gpt-4o-mini` reviewer 拿草稿對照下游任務的 `acceptanceCriteria`，打分 1–5；不夠好（<4）就把缺口（gaps）注回對話再挖，直到夠好或撞輪數上限才發布（Phase 2 self-review，第二個 sub-agent 範例）。

**硬性保留**（對外契約零改動）：
- result shape `{ handoffMarkdown: string; cached: boolean }` 不變。
- cache 語意不變：`force=false`（auto trigger）→ 已有 `handoffDoc` 即跳過；`force=true`（手動 callable）→ 必重生。
- `onTaskUpdated` 觸發路徑不動（仍 best-effort，handoff 失敗不擋指派/通知，也不擋其他下游任務）。
- 寫回 `tasks/{taskId}.handoffDoc` + `handoffGeneratedAt` 不變。

---

## 現況核查（actual code vs plan）— 讀過實際 code 後的修正

1. **`getCommitDiff` 沒有現成 API**。`githubClient.getCommit`（`githubClient.ts:62`）確實存在，但它回傳的 `CommitDetail` **只取 `files[].filename` 與 stats**，**丟掉了每檔的 `patch` 文字**。Octokit `repos.getCommit` 的 response 其實帶 `data.files[].patch`（unified diff）。所以 `getCommitDiff` **必須在 githubClient 新增一個 minimal method**（或擴 `getCommit` 但會動既有 explainCommit 契約——**不建議**，改新增獨立 method）。**見 D1/Q1。**
2. **`HandoffReviewSchema` 已存在**：`types.ts:37-42` 已有 `z.object({ score: z.number().int().min(1).max(5), gaps: z.array(z.string()) })` + `HandoffReview` type（顯然是先前 pre-staged）。**zod 不需新增 schema**，只需 import 使用。**這修正了原 spec「zod schema additions」一項——基本已備好。**
3. **trigger 呼叫點不動**：`onTaskUpdated.ts:109` 已是 `await generateHandoffFlow({ repoId, taskId: doc.id, force: false })` 包在 try/catch（best-effort）。簽章 `{repoId, taskId, force?}` 不變 → trigger 與 handler（`handlers/generateHandoff.ts`，`force: true`）**零改動**。
4. **`readTeamState(repoId)`**（`tools/assignTools.ts:31`）已 import 於現有 flow；回傳 `TeamMemberState[]`。Phase 1 直接包成工具。
5. **`searchDiscordMessages(repoId, query, limit?, range?)`** 回 `DiscordSnippet[]`（W2 後 vector-first）；現 flow 用 `.flatMap(s => s.messages)`。包工具時把 snippet 攤平成精簡 JSON 給 model。
6. **`searchPastCommits(repoId, query, limit?)`**（`tools/dailyIntel.ts:308`）回 `DayCommit[]`（W2 後 vector-first）。可直接當工具。
7. **`readRepoPlanningDocs(repoId)`**（`tools/repoDocs.ts:80`，W4）回 `RepoDocsResult`（含 `content` markdown、`summary`、`taskCounts`、自帶 10 分鐘 cache）。直接當工具，回 `content`（已 token-bounded ≤ 32000 chars）。
8. **commit 文件 doc id**：`commits/{sha}`，`linkedTaskIds` 由 `onCommitCreated` 解析 `#N`。現 flow 的「linkedTaskIds array-contains」查詢邏輯**原封不動抽成 `listRelatedCommits` 工具**（連同既有 best-effort try/catch 與 composite-index 降級註解）。
9. **owner/repo/token 解析**：`getCommitDiff` 要走 GitHub REST，需要 owner/repo + token。`tools/repoDocs.ts` 的 `resolveRepoContext`（repo `name` 切第一個 `/` → owner/repo；`repos.createdBy` → `users/{createdBy}.githubAccessToken`）**是 module-private、未 export**。**見 D2/Q2**：抽共用 helper vs 在 handoffTools 內各自實作一份。
10. **forced-finalize 範本**在 `summarizeDay.ts:241`（`round === MAX_ROUNDS-1` → `tool_choice: {type:'function', function:{name:'finalizeReport'}}`）；**round 結構 / tool_choice / 平行執行 read tools** 範本在 `assignTask.ts:160-239`。兩者直接複用。

---

## Files to change（逐檔說明）

### 1. `functions/src/flows/generateHandoff.ts`（**重寫**——主體）

整檔改寫為兩階段 agent。保留 `GenerateHandoffInput` / `GenerateHandoffResult` interface、cache 短路、not-found guard、write-back（best-effort）。新增 Phase 1 工具循環 + Phase 2 reviewer，外圈用「總輪數（totalRounds）」串接兩階段。

- 移除：確定性預取（prerequisites / commits / discord / roster 全部撈完）、單次 `getOpenAI().chat.completions.create`。
- 改為：先撈**最小 seed context**（task 本體：title / description / acceptanceCriteria；prerequisites 的 title/status，給 model 一個起點），其餘交給工具按需檢索。
- Phase 1：`gpt-4o`（`MODELS.reasoning`）工具循環。
- Phase 2：`gpt-4o-mini`（`MODELS.fast`）reviewer，`zodResponseFormat(HandoffReviewSchema)` structured output（`openai.beta.chat.completions.parse`，比照 `breakdownTask.ts:78`）。
- 保留檔頭 design 註解但更新為「two-phase agentic」描述。

### 2. `functions/src/prompts/generateHandoff.ts`（**改**）

- 改寫 `generateHandoffSystem`：從「你拿到全部 context，寫文件」改為「你是 agent，**先用工具自主檢索**真實證據（commit diff / Discord / .trellis / roster），再呼叫 `draftHandoff` 交出 markdown」。保留四段式輸出規格（What was done / Why / What's left / Gotchas）與 grounding 規則（不得捏造）。
- 新增 `generateHandoffSeedContext(input)`：產出 Phase 1 第一則 user message（task 本體 + prerequisites 簡表 + 「可用工具」提示）。可沿用 / 收斂現有 `generateHandoffContext`。
- **新增** `handoffReviewSystem`（reviewer 的 system prompt）：「你是嚴格的技術 reviewer。拿這份交接草稿對照下游任務的 acceptanceCriteria 與描述，判斷接手工程師能否照著開工。回 `{score: 1-5, gaps: string[]}`。score>=4=可發布；gaps 要具體（例如『沒提到 X commit 改了哪個檔』『漏了驗收條件 Y 的對應行動』），給 Phase 1 拿去補。」
- **新增** `handoffReviewContext({ draft, acceptanceCriteria, taskTitle, taskDescription })`：reviewer 的 user message。
- **新增** `handoffGapsFeedback(gaps)`：把 reviewer 的 gaps 整形成回注 Phase 1 的 user message 文字（見「Message threading」）。

### 3. `functions/src/services/githubClient.ts`（**改**——加一個 method）

新增 minimal diff fetcher（所有 GitHub API 仍集中此檔，ARCHITECTURE §6.4）：

```ts
export interface CommitDiffFile { filename: string; status: string; additions: number; deletions: number; patch: string | null; }
export interface CommitDiff { sha: string; message: string; files: CommitDiffFile[]; truncated: boolean; }
export async function getCommitDiff(owner, repo, accessToken, sha, maxPatchChars): Promise<CommitDiff>
```

- 走 `octokit.repos.getCommit({ owner, repo, ref: sha })`，**取出既有 response 已含的 `data.files[].patch`**（getCommit 已丟棄它，這裡保留）。
- **截斷**：逐檔累加 patch，總量超過 `maxPatchChars`（≈ 3000 tokens × 4 ≈ 12000 chars/commit）即停止後續檔案的 patch（設 `truncated: true`、其後檔 patch 設 `null`）。單檔 binary（無 patch）→ `patch: null`。
- **不動 `getCommit` / `CommitDetail`**（explainCommit 契約不變）。

### 4. `functions/src/tools/handoffTools.ts`（**新檔**——Phase 1 工具實作）

把 Phase 1 的 read-only 工具實作集中（仿 `assignTools.ts` / `dailyIntel.ts`：thin、read-only、never call OpenAI、best-effort 降級不 throw）：

- `listRelatedCommits(repoId, taskIds)` — 抽自現有 flow 的 `linkedTaskIds` array-contains 查詢（含 `COMMITS_PER_PREREQ` / `MAX_COMMITS` cap、composite-index 降級 try/catch）。回精簡 `{ sha(7), subject, aiSummary, author, filesChanged }[]`。
- `getCommitDiff(repoId, sha)` — 解析 owner/repo/token（共用 helper，見 D2），呼叫 `githubClient.getCommitDiff(..., MAX_PATCH_CHARS)`；best-effort 失敗回 `null` / 空。**只在 agent 點名 sha 時才打 GitHub**（cost guard）。
- `readTeamState` / `searchDiscordMessages` / `searchPastCommits` / `readRepoPlanningDocs` — **薄包現有函式**（不重實作），整形為 model 友善 JSON。
- 共用 `resolveRepoContext(repoId)` helper（見 D2）。

> Phase 1 的 OpenAI tool schema 與 dispatcher（switch）放在 flow 檔（比照 `assignTask.ts` 的 `TOOLS` + `runReadTool`），工具的「資料存取實作」放這檔。

### 5. `functions/src/types.ts`（**幾乎不動**）

- `HandoffReviewSchema` / `HandoffReview` **已存在（37-42）** → 直接用。
- 若選擇把 review metadata 結構化（rounds/score/gaps），**可選**加一個 `HandoffReviewMeta` interface（非 zod，純 TS）；或直接寫 plain object（見 D3）。

### 6. `functions/src/triggers/onTaskUpdated.ts`、`functions/src/handlers/generateHandoff.ts`（**不動**）

簽章不變故零改動。**唯一風險**：兩階段延遲變長（10→30s）。trigger `timeoutSeconds: 300`、handler `timeoutSeconds: 300` 都已足夠（見 Cost/Latency）。

### 7. `functions/src/__tests__/generateHandoff.test.ts`（**改寫**）

現有 5 個測試全部假設「一次 `chat.completions.create` 回 markdown content」，two-phase 後**必然失效**（mock 不再有 tool_calls/parse 路徑）。需改寫 mock 與斷言（見 Test plan）。

---

## The loop design（精確規格）

### 全域控制變數

- `MAX_PHASE1_ROUNDS = 4`（單次進 Phase 1 草擬，最多 4 個 model turn）。
- `TOTAL_ROUNDS_CAP = 5`（**全域** Phase-1 model turn 上限，跨多次 review-retry 累計；達到即強制收斂）。
- `MAX_TOOL_CALLS = 12`（**全域** 工具呼叫總數上限，cost guard；達到即在下個 turn 強制 `draftHandoff`）。
- `MAX_PATCH_CHARS = 12000`（≈3000 tokens/commit diff 截斷）。
- `REVIEW_PASS_SCORE = 4`。

### 外圈狀態機（pseudocode）

```
seedMessages = [ system(handoffSystem), user(seedContext) ]
messages = seedMessages
totalRounds = 0
toolCalls = 0
draft = null

loop (forever, bounded by caps):
  ── Phase 1: 草擬循環 ──────────────────────────────
  while draft is null:
    forceDraft = (totalRounds >= TOTAL_ROUNDS_CAP - 1) || (toolCalls >= MAX_TOOL_CALLS)
    completion = openai.chat.create({
      model: reasoning,                 // gpt-4o
      messages,
      tools: PHASE1_TOOLS,              // 含 draftHandoff 終止工具
      tool_choice: forceDraft
        ? { type:'function', function:{ name:'draftHandoff' } }   // 末輪強制收斂
        : 'auto',
    })
    totalRounds++
    push assistant message
    calls = completion.tool_calls ?? []
    if calls empty: push nudge("call draftHandoff or a tool"); continue
    if any call == draftHandoff:
      draft = call.args.markdown
      push tool result "ok" for that call (+ "ok"/skip for siblings)
      break
    // 否則執行 read tools（平行，比照 assignTask）
    toolCalls += calls.length
    run each tool → push role:'tool' results
    if totalRounds >= TOTAL_ROUNDS_CAP:   // 安全網：即使沒 forceDraft 也不再進 Phase 1
      forceDraft on next iteration

  ── Phase 2: self-review ───────────────────────────
  review = openai.beta.parse({ model: fast, messages:[system(reviewSystem),
            user(reviewContext{draft, acceptanceCriteria, taskTitle, taskDescription})],
            response_format: zod(HandoffReviewSchema) })
  if review.score >= REVIEW_PASS_SCORE  OR  totalRounds >= TOTAL_ROUNDS_CAP:
    finalize(draft, meta{ totalRounds, finalScore: review.score, retries }); return
  else:
    // review-retry：把 gaps 注回 Phase 1 對話，回頭再挖
    push user( handoffGapsFeedback(review.gaps) )
    draft = null     // 重新進 Phase 1（同一 messages 串，保留全部工具結果）
    // 回到 loop 頂端
```

### 退出條件（窮舉）

| 條件 | 行為 |
|---|---|
| review.score ≥ 4 | finalize 當前 draft（happy path） |
| review.score < 4 **且** totalRounds < 5 | 注入 gaps，回 Phase 1 再挖（review-retry path） |
| totalRounds == 5（撞全域上限） | 末輪已 `tool_choice` 強制 `draftHandoff`；review 後**無論分數一律 finalize 最後一版**（forced-stop path，防無限迴圈） |
| toolCalls == 12（撞工具上限） | 下個 turn 強制 `draftHandoff`，照常進 review（仍受 totalRounds cap） |
| draftHandoff 的 markdown 為空 | 比照現有：`HttpsError('internal', 'empty handoff')`（best-effort 由 trigger 接住） |

### Message threading（兩階段如何串、gaps 如何重新入對話）

- **單一 `messages` 串貫穿整個外圈**（Phase 1 的 assistant + tool 訊息全部累積保留）——這讓 review-retry 時 model 仍記得已檢索過哪些 commit / Discord，不重複打工具。
- **Phase 2 reviewer 用獨立、短的 messages**（只有 reviewSystem + draft + acceptanceCriteria），**不**污染 Phase 1 串、也吃不到一整串工具雜訊 → reviewer 便宜且聚焦。
- **gaps 回注**：review 失敗時，把 `handoffGapsFeedback(gaps)` 當一則 **`role:'user'`** 訊息 push 進 Phase 1 串（內容如：「Your draft was reviewed and scored {score}/5. Address these gaps before drafting again: - {gap1} - {gap2} … Use tools to gather the missing evidence, then call draftHandoff with an improved version.」），然後 `draft=null` 回 Phase 1。model 下一輪看到 gaps + 既有工具結果，決定補哪個工具或直接改寫。

---

## Tool schemas（Phase 1，OpenAI function-calling）

```jsonc
// listRelatedCommits — 抽自現有 linkedTaskIds 查詢
{ name:"listRelatedCommits",
  description:"List commits linked (via #N refs) to the given task ids — the prerequisites' real work. Returns sha/subject/author/filesChanged/aiSummary. Call this first to see what landed.",
  parameters:{ type:"object", properties:{
    taskIds:{ type:"array", items:{type:"string"},
      description:"Task ids to gather commits for (defaults to this task + its prerequisites if omitted)." }
  }, additionalProperties:false } }

// getCommitDiff — NEW，只對 agent 點名的 sha 抓
{ name:"getCommitDiff",
  description:"Fetch the unified diff (patch) of ONE commit by sha, truncated to ~3000 tokens. Use sparingly — only for commits whose change you must understand to write the handoff. Returns per-file patches.",
  parameters:{ type:"object", properties:{
    sha:{ type:"string", description:"Full or short commit sha from listRelatedCommits." }
  }, required:["sha"], additionalProperties:false } }

// searchDiscordMessages — 既有 vector-first
{ name:"searchDiscordMessages",
  description:"Semantic search the repo's Discord discussion for decisions, blockers, follow-ups behind this work. Returns grouped message snippets.",
  parameters:{ type:"object", properties:{
    query:{ type:"string", description:"Natural-language topic." }
  }, required:["query"], additionalProperties:false } }

// searchPastCommits — 既有 vector-first
{ name:"searchPastCommits",
  description:"Semantic search the whole repo commit history to ground a claim or find when something was last touched. Use sparingly.",
  parameters:{ type:"object", properties:{
    query:{ type:"string" }, limit:{ type:"number", description:"default 6" }
  }, required:["query"], additionalProperties:false } }

// readRepoPlanningDocs — W4 工具
{ name:"readRepoPlanningDocs",
  description:"Read the repo's in-repo planning context (.trellis tasks/prd, AGENTS.md/CLAUDE.md, docs) to understand project conventions and what's already done. Cheap (cached).",
  parameters:{ type:"object", properties:{}, additionalProperties:false } }

// readTeamState — 既有
{ name:"readTeamState",
  description:"List repo members (name, githubLogin) so you can refer to people by real name in the handoff.",
  parameters:{ type:"object", properties:{}, additionalProperties:false } }

// draftHandoff — 終止工具
{ name:"draftHandoff",
  description:"Submit your handoff document as GitHub-flavored markdown. Ends the drafting loop. Must follow the four-section format.",
  parameters:{ type:"object", properties:{
    markdown:{ type:"string", description:"The full handoff markdown." }
  }, required:["markdown"], additionalProperties:false } }
```

`tool_choice` 與末輪強制收斂同 `summarizeDay`：非末輪 `'auto'`，末輪 `{type:'function', function:{name:'draftHandoff'}}`。

---

## Zod schema（Phase 2 reviewer）

**已存在，無需新增**（`types.ts:37-42`）：

```ts
export const HandoffReviewSchema = z.object({
  score: z.number().int().min(1).max(5),
  gaps: z.array(z.string()),
});
export type HandoffReview = z.infer<typeof HandoffReviewSchema>;
```

reviewer 用 `openai.beta.chat.completions.parse({ model: MODELS.fast, messages, response_format: zodResponseFormat(HandoffReviewSchema, 'handoffReview') })`（比照 breakdownTask）。parse 回 null（refuse/empty）時：**視同 score=5 直接通過**（degrade gracefully——reviewer 壞掉不該讓整個 handoff 失敗；best-effort 哲學）。**見 Q3。**

---

## Prompt changes（摘要）

- **`generateHandoffSystem`**（改）：drafting agent 的 system prompt，「先用工具檢索證據，再 `draftHandoff`」+ 既有四段格式 + grounding 規則。
- **`handoffReviewSystem`**（新）：reviewer system prompt，輸出 `{score, gaps}`，score≥4=可發布的判準說明。
- **`generateHandoffSeedContext`**（新/改）：Phase 1 起始 user message（task + prerequisites 簡表）。
- **`handoffReviewContext`**（新）：reviewer user message（draft + acceptanceCriteria + task 描述）。
- **`handoffGapsFeedback`**（新）：gaps 回注 Phase 1 的 user message 整形。

---

## Review metadata 落點（justify）

**選擇：寫在 task doc**（與 `handoffDoc` 同步 update），欄位 `handoffReview: { totalRounds, finalScore, retries, reviewedAt }`。

理由：(1) 驗證清單明列「W1：handoff 至少出現過一次『review 退回再挖』的真實案例（log 留存，demo 可引述）」——寫進 task doc 讓 demo / 前端可**直接讀出「自我審查 2 輪、第一輪 3 分被退回」**這句台詞，比埋在 log 好取。(2) 同一次 write-back（best-effort）順手寫，零額外成本。(3) 同時 `logger.info('generateHandoff: finalized', {totalRounds, finalScore, retries})` 留一份在 log（雙保險，符合既有 logging 慣例）。**見 Q4 確認欄位命名是否需與前端對齊。**

---

## Cost / Latency budget

| 項目 | 估計 | 控制手段 |
|---|---|---|
| Phase 1 model | `gpt-4o`，1–5 個 turn（典型 2–3） | `TOTAL_ROUNDS_CAP=5` 全域上限 |
| Phase 2 model | `gpt-4o-mini`，每草稿 1 次（典型 1–2 次） | review-retry 受 totalRounds cap 連動 |
| 工具呼叫 | 全域 `MAX_TOOL_CALLS=12` | 撞上限即強制 draft |
| commit diff | 每 commit 截斷 ≤ ~3000 tokens（`MAX_PATCH_CHARS=12000`） | 逐檔累加截斷；**只抓 agent 點名的 sha** |
| GitHub API | 只在 `getCommitDiff` 觸發；readRepoPlanningDocs 自帶 10 分鐘 cache | per-sha 抓、cache |
| 延遲 | 典型 10–30s（vs 現 ~10s） | trigger/handler `timeoutSeconds:300` 已足；W5 工具軌跡把等待變展示（不在本工作項） |
| 失敗 | best-effort，不擋 trigger 其他下游任務 | 沿用既有 try/catch 包覆 |

---

## Test plan（jest + ts-jest，boundary-mock）

沿用既有 boundary-mock 慣例（fake db、scripted OpenAI、mocked tool helpers、no-op logger）。

### 既有測試的命運（**會破的**）

`__tests__/generateHandoff.test.ts` 現有 5 個 case **全部需改寫**——它們 mock 單一 `chat.completions.create` 回 markdown content、斷言 `toHaveBeenCalledTimes(1)` 與「user message 含 prerequisite/commit/criteria」。two-phase 後：
- not-found（保留，邏輯不變）。
- cache force=false 短路（保留，OpenAI 完全不呼叫——**斷言改為 create 與 parse 皆 0 次**）。
- 「generates + writes back」「force=true regenerates」「empty → internal」需重寫為 tool-loop 腳本。
- mock 需擴成：`chat.completions.create`（Phase 1，回 tool_calls：先 listRelatedCommits → 再 draftHandoff）+ `chat.completions.parse`（Phase 2，回 `{score, gaps}`）。

### 新 / 改寫測試覆蓋（對應退出條件）

1. **happy path**：Phase 1 第一輪呼 `draftHandoff` → Phase 2 回 `score:5` → finalize；斷言 `handoffDoc` 寫回、`handoffReview.totalRounds`/`finalScore` 寫回、result `{cached:false}`。
2. **tool-then-draft**：Phase 1 第一輪呼 `listRelatedCommits` + `getCommitDiff`（mock githubClient）→ 第二輪 `draftHandoff` → review pass；斷言工具被呼叫、diff 截斷生效。
3. **review-retry path**：Phase 2 第一次回 `score:3, gaps:[...]` → 斷言 gaps 以 user message 注回、Phase 1 再跑、第二次 review `score:4` → finalize；斷言 `retries>=1`。
4. **forced-stop path**：scripted 讓 Phase 1 一直只呼 read tools（不 draft）→ 撞 `TOTAL_ROUNDS_CAP` → 末輪 `tool_choice` 強制 draftHandoff（斷言 create 收到 `tool_choice.function.name === 'draftHandoff'`）→ 即使 review `score:2` 也 finalize。
5. **cache**：force=false + 已有 `handoffDoc` → 短路，create/parse 皆 0 次（回歸保護）。force=true → 重生。
6. **trigger best-effort**：（在 `onTaskUpdated.test.ts`，若現有）handoff flow throw 不應中斷指派/通知/其他下游——確認既有 onTaskUpdated 測試仍綠（two-phase 對 trigger 透明）。
7. **reviewer degrade**：parse 回 null → 視同 pass，不 throw（Q3 結論）。
8. **getCommitDiff 截斷**（githubClient 單測或 handoffTools 單測）：超過 `maxPatchChars` → `truncated:true`、後續檔 patch=null。
9. **empty draft**：draftHandoff markdown 空 → `HttpsError('internal')`。

**全綠門檻**：`npm --prefix functions run typecheck` 0 error、`npm --prefix functions test` 全過（現 33 suites / 250 → 改寫 generateHandoff.test + 可能新增 handoffTools/githubClient diff 測試）、`npm --prefix functions run lint` 0 error。

---

## Out of Scope

- **前端**：工具軌跡即時顯示（agentRuns side-channel）是 **W5** 的事；W1 純後端。handoff 重生按鈕（callable 已支援 force=true）若順手可由他人加，不在本工作項。
- **W3 projectBrief 前綴注入**：W3 完成後才把 brief 掛進 context prefix；W1 先不依賴（避免跨工作項耦合）。
- **新增 npm 依賴 / 部署 / 建 index**（`AI_AGENT_RULES §R2/R3`）。`listRelatedCommits` 的 `array-contains + orderBy` composite index 若 live 缺 → 沿用既有降級 try/catch（不新增 index）。
- **改 `getCommit` / explainCommit 契約**：新增獨立 `getCommitDiff` method，不動既有。
- **stream**：callable 不能 stream；本工作項不做進度回傳（W5 範疇）。
- **多 commit 平行抓 diff 的去重快取**：先不做（agent 點名數量有限 + `MAX_TOOL_CALLS` 兜底）。

---

## Risks

| 風險 | 緩解 |
|---|---|
| **R1 無限迴圈**（review 一直退回）。 | 全域 `TOTAL_ROUNDS_CAP=5` + 末輪 `tool_choice` 強制 draftHandoff + 撞上限後無論分數一律 finalize。**這就是 demo 的 Hard part ②。** |
| **R2 diff 爆 context**。 | 每 commit `MAX_PATCH_CHARS=12000` 截斷 + 只抓 agent 點名 sha + `MAX_TOOL_CALLS=12`。 |
| **R3 延遲變長（10→30s）**，trigger 內多個下游任務各跑一次。 | best-effort（失敗不擋）；timeout 300s 足；延遲展示交給 W5 軌跡（非本項）。 |
| **R4 reviewer 失效**（parse refuse/empty）讓 handoff 整個失敗。 | parse null → 視同 pass（degrade），never block（Q3）。 |
| **R5 既有 generateHandoff.test 全破**。 | 已預期；計畫納入改寫，並保留 not-found/cache 回歸 case。 |
| **R6 getCommitDiff token 解析失敗**（無 owner token / 私有 repo）。 | best-effort 回 null；agent 仍可只靠 commit subject + aiSummary + Discord + .trellis 草擬（不強制依賴 diff）。 |
| **R7 onCommitCreated 沒寫 `messageEmbedding` 的舊 commit** 讓 searchPastCommits 降級。 | W2 已處理 vector→keyword fallback；W1 不重複處理。 |

---

## Open Questions（已由 Fable 5 / orchestrator 放行 — RESOLVED）

- **Q1（getCommitDiff 實作位置）— RESOLVED**：在 `githubClient.ts` 新增獨立 `getCommitDiff(owner, repo, token, sha, maxPatchChars)` method，回傳逐檔截斷 patch；**不動** `getCommit` / `CommitDetail`（explainCommit 契約不變）。已實作。
- **Q2（owner/repo/token 解析共用）— RESOLVED**：採 (a) — 把 `tools/repoDocs.ts` 既有的 `resolveRepoContext` **加上 `export`**（並補一行 JSDoc 註明 handoffTools 共用），**不重複實作**。handoffTools 直接 import 使用。已實作。
- **Q3（reviewer 失效的降級）— RESOLVED**：Phase 2 `parse` 回 null / throw 時 **視同 PASS（finalize 當前 draft）+ `logger.warn`**，reviewer 失效永不擋 handoff（best-effort）。已實作（`reviewDraft` 回 `{score: REVIEW_PASS_SCORE, gaps: []}`）。
- **Q4（review metadata 欄位）— RESOLVED**：無前端預期欄位。寫 `tasks/{taskId}.handoffReview = { score, rounds, generatedAt }`（與 `handoffDoc` 同一次 best-effort write-back）。已實作。
- **Q5（seed context 內容量）— RESOLVED**：純 agentic — **不**預塞 commit 清單；agent 自己呼 `listRelatedCommits`（demo 軌跡更佳，背景流程延遲可接受）。seed 只含 task 本體 + prerequisites title/status。已實作。
- **Q6（draftHandoff 與 read tool 同輪）— RESOLVED**：同輪若 `draftHandoff` 與 read tool 並存，**draftHandoff 為準**（忽略同輪 read tool，比照 assignTask finalize 優先）；該輪所有 tool_call 仍補 `role:'tool'` 回覆使 thread 合法。已實作。

---

## Baseline（實作前已驗證，本分支 `feat/w1-agentic-handoff`）

- `npm --prefix functions run typecheck` → **0 error**。
- `npm --prefix functions test` → **33 suites / 250 tests，全綠**（jest force-exit 警告為既有現象，非失敗）。
- 與 spec 給的基準一致（33 suites / 250 tests）。
