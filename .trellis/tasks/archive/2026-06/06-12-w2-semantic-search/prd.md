# W2 — 語意搜尋強化（Semantic Search Upgrade）

> 對應 [`docs/FINAL_DEMO_PLAN.md`](../../../docs/FINAL_DEMO_PLAN.md) **W2**（W2a–W2d）。
> 分支 `feat/w2-semantic-search`，worktree `ssfinal/gitsync-w2`，base `feature/agentic-final-demo`。
> **本文件為計畫；實作前須經 Fable 5 review 放行。**

---

## Goal

把所有 agent 的檢索從「關鍵字」升級為「**語意優先、關鍵字兜底**（vector-first, keyword-fallback）」，並補齊歷史資料的 embedding。這是 W1（agentic 交接文件）與 W5（統一問答）的檢索地基。

四個子項：

- **W2a** — `onDiscordMessageCreated` 補上 embedding（目前是 stub）。
- **W2b** — `searchDiscordMessages` 升級為向量優先 + 關鍵字兜底，**回傳形狀不變**。
- **W2c** — `searchPastCommits`（commit 搜尋）統一為向量優先 + 關鍵字兜底，**回傳型別不變**。
- **W2d** — 一次性 callable `backfillEmbeddings({ repoId, collection })` 回填缺 embedding 的舊資料。

**核心約束**：所有 W2b/W2c 改動**只換內部檢索策略**，對外回傳形狀／型別零改動，上游 caller 零改動。

---

## 現況核查（actual code vs plan）

讀過實際 code 後確認 / 修正：

1. **W2a stub 位置**：計畫寫 `onDiscordMessageCreated.ts:29-33`，實際 stub 在 `:29-34`（`TODO Sprint 4` 註解 + `logger.info('onDiscordMessageCreated stub', ...)`）。filter（`shouldKeepMessage`）與 idempotency（`markIdempotent`）已就位，只缺 embedding 寫入。
2. **vector index 已預留 ✅**：`firestore.indexes.json` 已有 `discordMessages` 的 `repoId + embedding`（COLLECTION_GROUP, 1536, flat）向量索引、以及 `commits` 的 `repoId + messageEmbedding`（COLLECTION）向量索引。**W2 不需要新增 index**（W2c 對 commits 不帶 `author.login` prefilter，沿用既有的 `repoId + messageEmbedding`）。註：`searchDiscordMessages` 查的是**單一 repo 的子集合**（`collection(...discordMessages)`），但既有 discordMessages 向量索引的 `queryScope` 是 `COLLECTION_GROUP`；需確認單一 collection 的 `findNearest` 能否命中 COLLECTION_GROUP 索引，或改用 `db.collectionGroup('discordMessages').where('repoId','==',repoId)`（與 `searchMemberCommits` 對 commits 的寫法不同——後者用 `collection(...)` 配 COLLECTION-scope 索引）。**見 Open Question Q1。**
3. **欄位契約（Rule F）**：schema doc（`ARCHITECTURE.md §2.1`）的 `discordMessages` 只列 `authorId`，但實際 `discordMessageIngest` 寫入時**有寫 `authorName`**（且 `searchDiscordMessages` 依賴它）。embedding 欄位名稱在 schema 與 index 都是 `embedding`（commits 是 `messageEmbedding`）——W2a 必須寫 `embedding`，W2b 必須 prefilter `repoId` + `findNearest({ vectorField: 'embedding' })`。
4. **參考實作 `searchMemberCommits`**（`tools/assignTools.ts`）：已是「embed(query) → `.where('repoId','==',repoId)` → `findNearest({ vectorField:'messageEmbedding', limit, distanceMeasure:'COSINE' })` → try/catch 降級為 `[]`」的完整向量檢索範本。W2b/W2c 照抄此骨架。
5. **`searchPastCommits` 回傳 `DayCommit[]`**（`tools/dailyIntel.ts`），被 `summarizeDayFlow` 與 `dailyBriefChatFlow` 用 `collect(cs)` / 直接 JSON.stringify 消費。W2c **必須維持回傳 `DayCommit[]`**（同欄位：sha/message/authorLogin/authorName/aiSummary/linkedTaskIds/additions/deletions）。
6. **`searchDiscordMessages` 回傳 `DiscordSnippet[]`**（分組對話 snippet：channelId + messages[] + score，`isMatch` 標記）。caller：`discordChatFlow`（依 `snippetKey` 去重）、`generateHandoff`（`.flatMap(s => s.messages)`）。W2b **必須維持回傳 `DiscordSnippet[]`**，且 snippet 的 context-grouping（命中前後 ±2 同頻道）要能繼續運作。
7. **`linkedTaskIds` AI 推斷（W2a 可選項）**：建議**不做**（OUT of scope）——理由見下方 Risks/Out-of-Scope。

---

## Files to change（逐檔說明）

### W2a — `functions/src/triggers/onDiscordMessageCreated.ts`（改）

照抄 `onCommitCreated.ts` 的 embedding 路徑（Rule D：所有重活在 idempotency guard 之後）：

- 移除 `TODO Sprint 4` 註解與 stub `logger.info`。
- filter 已先跑（`shouldKeepMessage`，命中即 return，不寫 embedding）——保留不動。
- 新增 embedding 步驟：
  - `import { embedToFieldValue } from '../tools/embedding';`
  - `const content = msg.content as string | undefined;` 取不到內容即 return。
  - try/catch 呼叫 `embedToFieldValue(content)`，成功 → `update.embedding = ...`，失敗 → `logger.warn`（best-effort，留 null，符合 Rule D 寬鬆模式）。
  - `await db.doc('apps/gitsync/repos/${repoId}/discordMessages/${messageId}').update(update)`。
- **欄位名 = `embedding`**（與 schema/index 一致；**不是** `messageEmbedding`）。
- 需要在 trigger 的 `secrets:[openaiKey]`（已存在）下用 `getOpenAI`（embedding 經 `embed()` 已自帶）。
- **不做** `aiSummary`（commit 才有；Discord 訊息 schema 無此欄）。
- **不做** `linkedTaskIds` AI 推斷（見 Out of Scope；`discordMessageIngest` 已寫 `linkedTaskIds: []`）。
- 取 `repoId`/`messageId`：`event.params as { repoId: string; messageId: string }`。

### W2b — `functions/src/tools/discordSearch.ts`（改 `searchDiscordMessages`）

把目前「拉最近 SCAN_LIMIT 筆 → keyword `buildSnippets`」改為**向量優先**：

1. **新增 vector-first 路徑**（query 非空時）：
   - `const queryVector = await embed(query);`（import `./embedding` 的 `embed`）。
   - `findNearest`：對 discordMessages 帶 `.where('repoId','==',repoId)` 預過濾，`vectorField:'embedding'`, `limit ~10`, `distanceMeasure:'COSINE'`（**limit 取 ~10 命中筆數**，非 snippet 數）。
   - **range 處理**：若帶 `range`，同時 `.where('timestamp','>=',range.start).where('timestamp','<',range.end)`（需確認複合向量索引是否支援 timestamp 額外 filter——若不支援，range 模式直接走 keyword fallback。**見 Q2**）。
   - 命中後仍需要**上下文 grouping**：findNearest 只回命中的 N 筆，但 snippet 需要前後 ±2 同頻道訊息。做法：拿到命中的 messageId 集合後，**仍掃一批最近訊息**（或以命中 message 的 channel+附近 id 範圍補抓），把命中筆標記後丟給既有 `buildSnippets` 的 grouping 邏輯。**簡化方案**：vector 命中只用來「決定哪些 message 算 match」，再把命中 message 的 content 拼成 query 餵回現有 keyword grouping？——這會破壞語意。**建議**：抽出一個 `buildSnippetsFromMatches(docs, matchedIds, opts)` 變體（純函式，可單測），讓 grouping 吃「已標記命中的 id 集合」而非「keyword terms」。**見 Q3（grouping 與 vector 命中如何結合）。**
2. **graceful fallback** 回現有 keyword + recency（`buildSnippets`）路徑，觸發條件：
   - query 為空 / 無可用 terms；
   - `embed()` 拋錯；
   - `findNearest` 拋錯（含缺 index `9 FAILED_PRECONDITION`）；
   - 向量命中 0 筆。
3. **回傳形狀不變**：仍回 `DiscordSnippet[]`；既有 keyword 路徑與 `buildSnippets` 純函式**完整保留**（fallback 用）。
4. **best-effort**：整體仍 `try/catch → logger.warn → 回 []`（NEVER throws，維持現狀）。
5. 既有 `searchDiscordMessages` 的呼叫簽章不變（`repoId, query, limit?, range?`）。

### W2c — `functions/src/tools/dailyIntel.ts`（改 `searchPastCommits`）

把目前「拉最近 300 筆 → keyword score」改為**向量優先**，回傳仍是 `DayCommit[]`：

1. **vector-first**（query 非空時）：
   - `const queryVector = await embed(query);`（import `./embedding`）。
   - `db.collection('apps/gitsync/repos/${repoId}/commits').where('repoId','==',repoId).findNearest({ vectorField:'messageEmbedding', queryVector, limit: cap, distanceMeasure:'COSINE' }).get()`（沿用 `commits` 既有 `repoId + messageEmbedding` 索引，**COLLECTION scope**，與 `searchMemberCommits` 一致但不帶 `author.login`）。
   - 命中 docs → `toDayCommit(d.id, d.data())`（既有 helper，回傳形狀天然一致）。
2. **graceful fallback** 回現有 keyword + recency：query 空、`embed()` 失敗、`findNearest` 失敗、命中 0 筆 → 走既有掃描+token 計分路徑（**保留現有實作**）。
3. 簽章不變（`repoId, query, limit?`，`PAST_DEFAULT=8`, `PAST_MAX=20`）；回傳仍 `DayCommit[]`。
4. best-effort `try/catch → []`，維持現狀。
5. 既有 `tokenize` 與 keyword 計分邏輯保留作 fallback。

### W2d — `functions/src/handlers/backfillEmbeddings.ts`（新檔，callable）

一次性回填 callable，仿既有 `onCall` 骨架（auth-guard 同 `discordChat.ts` / `assignTask.ts`）：

- `onCall({ region: REGION, secrets: [openaiKey], timeoutSeconds: 300 }, handler)`。
- **auth-guard**：`if (!request.auth) throw new HttpsError('failed-precondition', 'Please log in first.')`。
- **input 驗證**：`{ repoId: string, collection: 'commits' | 'discordMessages' }`；缺 / 非法 → `HttpsError('invalid-argument', ...)`。
- **per-repo + per-collection**（強制，控制儲存成本——見 Cost/Storage）。
- 流程（idempotent + batched）：
  1. 依 collection 決定 embedding 欄位（`commits→messageEmbedding`、`discordMessages→embedding`）與 noise filter（`commits→shouldSkipEmbedding(message)`、`discordMessages→shouldKeepMessage({content})`）與內容欄位（`commits→message`、`discordMessages→content`）。
  2. 掃 `apps/gitsync/repos/${repoId}/${collection}`，**分批 ~50 筆/batch**（用 `orderBy(documentId)` + `startAfter` cursor 翻頁，避免 timeout）。
  3. 每筆：**已有 embedding → skip**（idempotent）；過 noise filter（命中 → skip，不寫）；否則 `embed(content)` → `update({ [field]: FieldValue.vector(vec) })`。
  4. 累計 `scanned / embedded / skippedExisting / skippedFiltered / failed`，回傳統計物件。
- **best-effort**：單筆 embed 失敗 → `logger.warn` 計入 `failed`，不中斷整批。
- 為避免 300s timeout：建議**單次呼叫只處理一個 batch 段**並回 `nextCursor`（前端/手動重呼），或在 300s 內盡量跑、回 `done:false` + cursor。**見 Q4（單呼叫跑完 vs 分頁回 cursor）。**
- **register**：`functions/src/index.ts` 的 `// ---- Callables ----` 區塊加 `export { backfillEmbeddings } from './handlers/backfillEmbeddings';`。

### `functions/src/index.ts`（改）

只加一行 export（見上）。

### `firestore.indexes.json`

**不需改動**（W2a/b 的 discordMessages 向量索引、W2c 的 commits 向量索引皆已存在）。**唯一待確認**：discordMessages 索引的 `queryScope` 是 `COLLECTION_GROUP`，W2b 若用單一 `collection(...)` 查可能命中不到 → 改用 `collectionGroup('discordMessages')`，或請使用者新增一筆 COLLECTION-scope 索引（見 Q1，索引部署是使用者的事，`AI_AGENT_RULES §R2`）。

---

## Fallback-chain 設計（統一語意）

兩個搜尋工具走同一條降級鏈，與既有 Rule D「best-effort、寧可降級不要 throw」一致：

```
搜尋請求
  │
  ├─ query 有可用 terms？ ── 否 ──▶ keyword/recency fallback（既有路徑）
  │   是
  ▼
  embed(query)  ── throw ──▶ keyword fallback（logger.warn）
  │ ok
  ▼
  findNearest(repoId prefilter, COSINE, limit~10)
  │   ├─ throw（含缺 index FAILED_PRECONDITION）──▶ keyword fallback（logger.warn）
  │   ├─ 命中 0 筆 ──────────────────────────────▶ keyword fallback
  │   └─ 命中 N 筆
  ▼
  整形為既有回傳型別（DiscordSnippet[] / DayCommit[]）
  │
  └─ 任何未預期錯誤 ──▶ try/catch 最外層 → 回 []（NEVER throws）
```

**設計重點**：
- vector 與 keyword **共用同一個整形/grouping 出口**，確保回傳形狀對 caller 完全透明。
- fallback 不是「錯誤」，是正常路徑（demo 前若忘了 backfill、或 fake backend 無向量，照樣可用）——沿用 `searchMemberCommits` 的 best-effort 哲學。
- 缺 index 在 live 才會 `FAILED_PRECONDITION`（部署是使用者的事）——fallback 讓它降級而非崩潰。

---

## Index / Deployment notes

- **Vector index 已預留**（已核查 `firestore.indexes.json`）：
  - `commits`：`repoId(ASC) + messageEmbedding(vector 1536 flat)`，scope `COLLECTION` → W2c 用。
  - `commits`：`repoId(ASC) + author.login(ASC) + messageEmbedding` → `searchMemberCommits` 用（W2 不碰）。
  - `discordMessages`：`repoId(ASC) + embedding(vector 1536 flat)`，scope `COLLECTION_GROUP` → W2a/b 用。
- **W2 不新增也不刪 index**（除非 Q1 結論需要一筆 COLLECTION-scope discordMessages 索引）。
- **AI 絕對不部署**（`AI_AGENT_RULES §R2`）：若需 deploy index，由**使用者**跑 `firebase deploy --only firestore:indexes`；AI 只把指令字串貼出。
- **backfill 是 callable，非腳本**，demo 前由使用者對演示 repo 各 collection 各跑一次即可（計畫 §W2d）。

---

## Cost / Storage（journal 警示：embeddings ×3 儲存、1GB quota）

- 每個 1536-dim float embedding ≈ 數 KB；對大量 commits/discordMessages 回填會明顯吃 Firestore 儲存。
- **控制手段**：`backfillEmbeddings` 強制 **per-repo + per-collection**（不提供「全 repo 一鍵回填」），讓使用者只對演示 repo 回填。
- **noise filter 省量**：回填時套用既有 `shouldSkipEmbedding` / `shouldKeepMessage`，跳過無語意價值的訊息/commit，避免白佔空間與 token。
- demo 用單一 repo + 已過濾，估計遠低於 1GB；正式環境若要全量回填需另議（post-demo）。

---

## Test plan（jest + ts-jest，boundary-mock）

沿用既有 boundary-mock 慣例（`__tests__/*.test.ts`，mock `firebase-functions/*`、`../admin` fake db、`../config` / `../tools/embedding`）。

**擴充既有測試**：

1. `functions/src/__tests__/onDiscordMessageCreated.test.ts`（**新檔**——目前無此測試；仿 `onCommitCreated.test.ts`）：
   - filter 命中 → 不 embed、不 update（或 update 不含 embedding）。
   - 正常訊息 → `embedToFieldValue` 被呼叫、`update.embedding` 寫入向量 sentinel。
   - embed 失敗（mock reject）→ best-effort，不 throw，embedding 留空。
   - duplicate delivery（`markIdempotent → false`）→ no-op。
2. `functions/src/__tests__/discordSearch.test.ts`（**擴充**）：
   - 既有 `buildSnippets` / range / fallback 測試**全部保留**（回歸保護回傳形狀）。
   - 新增：mock `../tools/embedding` 的 `embed`，向量命中 → 回 `DiscordSnippet[]` 且 grouping 正確。
   - 新增：`embed` 失敗 / `findNearest` 失敗 / 命中 0 → 降級回 keyword 路徑（斷言仍回既有形狀）。
3. `functions/src/__tests__/dailyIntel`（commit 搜尋）：
   - 目前 `searchPastCommits` 似無專屬測試檔（`discordSearch.test.ts` 測 discord；commit 搜尋未見）。**新增** `functions/src/__tests__/searchPastCommits.test.ts`（或併入既有 dailyIntel 測試若有）：
     - 向量命中 → 回 `DayCommit[]`（欄位齊全）。
     - embed/findNearest 失敗 / 命中 0 → 降級回 keyword 計分路徑，仍回 `DayCommit[]`。

**新增測試**：

4. `functions/src/__tests__/backfillEmbeddings.test.ts`（**新檔**）：
   - auth 缺 → `failed-precondition`。
   - `collection` 非法 → `invalid-argument`。
   - 已有 embedding 的 doc → skip（不呼叫 embed）。
   - noise filter 命中 → skip。
   - 正常 doc → embed + update，統計正確。
   - 單筆 embed 失敗 → 計入 failed，不中斷整批。
   - batching：超過一個 batch 的 doc 數，斷言 cursor / 多 batch 行為（依 Q4 結論）。

**全綠門檻**：`npm --prefix functions run typecheck` 0 error、`npm --prefix functions test` 全過（含既有 211 + 新增）、`npm --prefix functions run lint` 0 error。

---

## Out of Scope

- **W2a 的 `linkedTaskIds` AI 推斷**（計畫標「可選 / 順手做」）：**不做**。理由：(1) 需多一次 mini 模型 structured-output 呼叫 + task roster 撈取，非「trivially cheap」；(2) 與 W2 核心地基（embedding + 向量搜尋）無依賴；(3) 增加 trigger 延遲與成本。建議列為 post-W2 的獨立小工作（若 W1 交接檢索證實需要再補）。
- **commits/discordMessages 以外的 collection**（pullRequests 等）向量化 / 回填。
- **排程版 backfill**（計畫明示「不必做排程版」，demo 前手動跑一次）。
- **前端改動**：W2 純後端；搜尋回傳形狀不變，UI 零改動。
- **Fake backend 的向量支援**：fake 模式無 `findNearest`，自動走 keyword fallback（這正是 fallback 設計的附帶好處），不為 fake 另做向量。
- **新增 npm 依賴 / 部署 / 建 index**（`AI_AGENT_RULES §R2/R3`）。

---

## Risks

| 風險 | 緩解 |
|---|---|
| **R1 grouping 與向量命中結合**（W2b 最棘手）：findNearest 只回命中筆，但 snippet 要前後 ±2 同頻道上下文。硬湊可能破壞回傳形狀或語意。 | 抽純函式 `buildSnippetsFromMatches`（吃「已命中 id 集合」而非 keyword terms），可單測；命中後仍掃一批近訊息補上下文。**待 Q3 拍板。** |
| **R2 discordMessages 索引 scope 不符**：既有索引是 COLLECTION_GROUP，W2b 若用單 `collection(...)` 查可能不命中索引 → live `FAILED_PRECONDITION`（fallback 會接住，但就失去語意搜尋）。 | 用 `collectionGroup('discordMessages').where('repoId','==',repoId)`，或請使用者加 COLLECTION-scope 索引。**待 Q1。** |
| **R3 range + 向量複合查詢**：findNearest 疊 timestamp range filter 可能需要額外複合向量索引（或不支援）。 | range 模式若不支援向量，直接走 keyword fallback（既有 range 行為完整保留）。**待 Q2。** |
| **R4 儲存成本**（journal 警示）：×3 embedding、1GB quota。 | per-repo+per-collection backfill、noise filter、demo 只回填單 repo。 |
| **R5 回傳形狀回歸**：W2b/W2c 是熱路徑，caller（discordChat / generateHandoff / summarizeDay / dailyBrief / 未來 askRepo）依賴精確形狀。 | 保留既有 keyword 路徑與其單測作回歸網；vector 與 keyword 共用整形出口；新增測試斷言兩路徑回傳同型別。 |
| **R6 onDiscordMessageCreated 延遲 / 成本**：每則訊息多一次 embedding 呼叫。 | filter 先擋噪音（已就位）；best-effort、失敗留 null 不重試（Rule D 寬鬆模式）。 |

---

## Open Questions（給 orchestrator，請勿自行猜測）

> 全部已由 Fable 5 拍板，下方各加「**Resolved**」一行；實作以裁定為準。

- **Q1（index scope）**：W2b 的 `searchDiscordMessages` 查單一 repo 子集合。既有 discordMessages 向量索引是 `COLLECTION_GROUP` scope。應該 (a) 把查詢改為 `collectionGroup('discordMessages').where('repoId','==',repoId)` 以命中既有索引，還是 (b) 維持 `collection(...)` 並請使用者新增一筆 COLLECTION-scope 索引？（`searchMemberCommits` 對 commits 用的是 `collection(...)` + COLLECTION-scope 索引，兩者目前不一致。）
  - **Resolved (a)**：用 `db.collectionGroup('discordMessages').where('repoId','==',repoId).findNearest(...)` 命中既有 COLLECTION_GROUP 索引，**不新增任何 index**；commits/`searchMemberCommits` 維持原樣不動。
- **Q2（range + 向量）**：`searchDiscordMessages` 在帶 `range` 時，是否要嘗試「向量 + timestamp range」複合查詢（可能需新索引），還是 range 模式一律走 keyword fallback、只有無 range 時才用向量？（discordChat 帶 range 是常見路徑。）
  - **Resolved**：永不做向量+range 複合查詢（findNearest 不支援 inequality prefilter）。帶 `range` 時：向量查詢**不帶** range、over-fetch（limit 20），再在記憶體中以 timestamp 後過濾命中；若過濾後剩 0 筆 → 退回既有 keyword 路徑（keyword 已處理 range）。
- **Q3（snippet grouping 與向量命中結合方式）**：W2b 命中後如何補「前後 ±2 同頻道上下文」並維持 `DiscordSnippet[]` 形狀——採「命中 id 集合 → 掃近訊息補上下文 → `buildSnippetsFromMatches`」是否可接受？或 W2b 只要求「snippet 仍分組、isMatch 標記正確」而不強求每筆向量命中都帶滿 ±2 上下文？
  - **Resolved**：採此設計。向量命中產生 matched-id 集合，沿用既有「掃近訊息」window 補 ±2 同頻道上下文，餵入抽出的純函式 `buildSnippetsFromMatches(docs, matchedIds, opts)`（複用既有 grouping 邏輯）。落在 window 外的命中可作單筆 snippet（無上下文，可接受）；**不**為每筆命中發 per-hit context query。
- **Q4（backfill 單呼叫 vs 分頁）**：`backfillEmbeddings` 在大 repo 上可能超過 300s。應該 (a) 單次呼叫盡量跑、回 `{ done:false, nextCursor }` 讓使用者重呼，還是 (b) 假設 demo repo 量小、單呼叫跑完即可（簡化）？
  - **Resolved (a)**：cursor 分頁。callable 回 `{ done: boolean, nextCursor?: string, stats: {...} }`；以 ~50 筆/batch 在 soft time budget（~240s）內處理，未跑完回 cursor；冪等重呼從 cursor 續跑。
- **Q5（W2a linkedTaskIds）**：確認 `linkedTaskIds` AI 推斷判為 OUT of scope（本計畫建議不做）是否與 orchestrator 一致？
  - **Resolved**：確認 OUT of scope，不做。

---

## Baseline（實作前已驗證）

- `npm --prefix functions run typecheck` → **0 error**。
- `npm --prefix functions test` → **29 suites / 211 tests，全綠**（jest 有一個 force-exit 警告，非失敗，既有現象）。
