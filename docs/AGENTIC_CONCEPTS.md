# Agentic Context Engineering 課程概念（OpenClaw 框架）

> **這份文件的用途**：給隊友的 AI assistant 在設計與實作 GitSync 的 AI Flow 時參考。搭配 [`ARCHITECTURE.md §5`](./ARCHITECTURE.md) 與 [`COURSE_METHODS.md §8`](./COURSE_METHODS.md) 一起看。
>
> **來源**：軟體設計與實驗課程投影片 P17-28（OpenClaw 框架介紹）
>
> **記錄日期**：2026-06-02

---

## 0. 核心定義

**Agentic = LLM 不只是「問一答一」，而是自己決定要用什麼工具、查什麼資料、叫誰幫忙、做幾輪，直到任務完成為止。**

---

## 1. 系統架構五大元件（P17-20）

OpenClaw 是一個開源的「代理式上下文工程框架」，包含五個核心元件：

| OpenClaw 元件 | 職責 | GitSync 對應 |
|---|---|---|
| **Gateway** | 接收訊息（Slack/WhatsApp 等），路由到 LLM | Cloud Functions callable / HTTP webhook |
| **Brain** | 呼叫 LLM，用 ReAct loop 決定下一步 | OpenAI function calling loop（`functions/src/flows/`） |
| **Tools** | 讓 LLM 執行動作（讀寫檔案、跑指令、查資料庫） | `functions/src/tools/` 下的純函式（`readTeamState`, `searchMemberCommits` 等） |
| **Skills** | 預寫好的 SOP 指令檔（SKILL.md） | `flows/` + `prompts/` + `types.ts`（Zod schema） |
| **Memory** | 持久化記憶，跨 session 保留 | Firestore 文件（commits, discordMessages, tasks） |

**每個 session 有獨立 context**：對應 GitSync 每次 callable 呼叫都是獨立的 flow 執行。

### 主對話上下文的組成

每次 LLM 收到的 context 包含：
- **System prompt**：規則、可用工具清單、技能列表、時間等
- **Metadata**：當下可用的 tools 及其 JSON schema
- **對話紀錄**：user ↔ assistant 的來回

---

## 2. 背景任務機制（P21-22）

| 機制 | 定義 | 範例 | GitSync 對應 |
|---|---|---|---|
| **Cron Job** | 特定時間執行，**獨立 session** 不干擾主對話 | 「中午 12 點發送訊息」 | `scheduledDailyReport` — 每天 18:00 生日報 |
| **Heartbeat** | 週期性檢查，**主 session 內**運行 | 「每 30 分鐘檢查有沒有新論文」 | `scheduledUnstickBreakdown` — 每 10 分鐘檢查卡住的拆解鎖 |

**設計要點**：
- Cron 適合「定時產出」（日報、週報），因為獨立 session 不會佔用使用者的對話
- Heartbeat 適合「監控巡邏」（解鎖卡住的鎖），因為需要在主 session 內快速反應

---

## 3. 技能系統 Skills（P23-24）

### SKILL.md 標準結構

```
名稱 + 描述
觸發條件（何時啟用這個技能）
逐步流程（Step-by-step procedure）
細節注意事項（Nuances）
執行腳本指令
成功標準（Success criteria）
```

### GitSync 對應

| SKILL.md 欄位 | GitSync 實作 |
|---|---|
| 觸發條件 | Callable handler 的 auth check + `isBreakingDown` lock |
| 逐步流程 | `flows/breakdownTask.ts` 的 Step 1-6 |
| 成功標準 | `types.ts` 的 Zod schema（`BreakdownOutputSchema`） |
| 細節注意事項 | `prompts/breakdownTask.ts` 的 system prompt rules |

### 可分享

OpenClaw 有 **ClawHub** 平台分享技能（類似 npm），可以 `openclaw skills install <name>`。

---

## 4. 上下文管理與記憶體（P25-27）— 最重要的概念

LLM 的 context window 有限（就像工作台面只有這麼大）。東西放太多就放不下了。

### a) Context Compression（壓縮）

```
原本：100 輪完整對話（太長了！）
     ↓ 壓縮
壓縮後：「前面聊了 X、決定了 Y、目前在做 Z」（摘要）+ 最近 10 輪完整對話
```

- OpenClaw 用 `/compact` 指令觸發，或自動在超過閾值時執行
- **GitSync 對應**：Prompt Caching 策略（[ARCHITECTURE §5.5](./ARCHITECTURE.md)）— 不變的 system prompt + project context 放前面，讓 OpenAI 自動 cache（省 50% token）

### b) RAG（Retrieval-Augmented Generation，檢索增強生成）

```
不把所有記憶塞進 context，而是：
1. 把重要事實切塊 → 算 embedding 向量 → 存到外部資料庫
2. 需要時用 cosine similarity KNN 搜尋 → 撈回最相關的記憶
```

**GitSync 對應**：

| 資料來源 | Embedding 欄位 | 向量維度 | 搜尋方式 |
|---|---|---|---|
| Commits | `messageEmbedding` | 1536 (text-embedding-3-small) | Firestore `findNearest` + `repoId` 預過濾 |
| Discord 訊息 | `embedding` | 1536 | 同上 |

Agent tools 就是 RAG 的取用介面：
- `searchMemberCommits(memberId, query)` → vector search on commits
- `searchDiscordMessages(repoId, query)` → vector search on discordMessages
- `searchPastCommits(repoId, query)` → vector search on commits

### c) Pruning（修剪）

- 選擇性移除工具回傳的冗長結果，只保留摘要
- 不改寫 transcript，只影響當次送給 model 的內容
- **GitSync 對應**：`shouldSkipEmbedding(message)` 過濾無語義 commit（Merge branch、Bump version 等），避免污染向量庫

---

## 5. Sub-agents 子代理（P28）

當遇到需要多工處理或較龐大的任務時，主 Agent 衍生出子代理來**平行**處理：

```
主 Agent：「比較 A 和 B」
  ├── Sub-agent 1：研究 A（獨立 context）
  ├── Sub-agent 2：研究 B（獨立 context）
  └── 等兩個都回來 → 主 Agent 整合結果
```

### 兩種模式

| 模式 | 說明 | 優點 | 缺點 |
|---|---|---|---|
| `isolated` | 子代理只拿到任務描述，不知道前因後果 | 省 token、互不干擾 | 缺少上下文可能做錯 |
| `fork` | 子代理拿到主對話完整記錄 | 知道前因後果 | 花更多 token |

### GitSync 對應

Cloud Tasks 扇出（[ARCHITECTURE §5.4](./ARCHITECTURE.md)）本質上就是 isolated sub-agent 模式：

```
scheduledDailyReport（主 Agent）
  ├── dailyReportWorker(repo-1)  ← 獨立 context
  ├── dailyReportWorker(repo-2)  ← 獨立 context
  └── dailyReportWorker(repo-N)  ← 獨立 context
```

每個 worker 只知道自己的 `repoId + date`，互不干擾，結果各自寫回 Firestore。

---

## 6. 整體架構圖

```
┌─────────────────────────────────────────────────┐
│                   Context Window                 │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ System   │  │ 對話歷史 │  │ Tool 結果     │  │
│  │ Prompt   │  │ (壓縮後) │  │ (修剪後)      │  │
│  └──────────┘  └──────────┘  └───────────────┘  │
│         滿了？ → Compact / Prune                 │
└──────────────────────┬──────────────────────────┘
                       │
              LLM（Brain）判斷下一步
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
    用 Tool        叫 Sub-agent    查 Memory/RAG
   （讀檔案、      （平行處理）   （語義搜尋
    跑指令）                       外部記憶）
         │             │             │
         └─────────────┼─────────────┘
                       ▼
                  回傳結果給使用者
```

---

## 7. GitSync 四個 Flow 的 Agentic 等級對照

| Flow | Agentic 等級 | 用到的課程概念 |
|---|---|---|
| `breakdownTaskFlow` | 半 Agentic | Structured Output + 自我修正（Brain re-prompt） |
| `assignTaskFlow` | **全 Agentic** | Function Calling loop × 5 輪 + 4 Tools + agent 自主決策 |
| `generateHandoffFlow` | **全 Agentic + Self Review** | Function Calling + 7 Tools + RAG + Sub-agent 式評分回饋 |
| `summarizeDayFlow` | **全 Agentic** + Sub-agent 扇出 | Function Calling loop（`getDayDigest`/`searchPastCommits`/`finalizeReport`）+ 純 TS 精確計數（pruning）+ Cloud Tasks isolated sub-agent 扇出 |
| `dailyBriefChatFlow` | **全 Agentic** | Function Calling loop + 4 唯讀 Tools（情報總站「問 AI 今天」）|

### 各 Flow 對應的 Agentic 概念拆解

**`assignTaskFlow`**（最典型的 Agentic 設計）：
- **Brain**：OpenAI GPT-4o 的 function calling loop，最多 5 輪
- **Tools**：`readTeamState` / `searchMemberCommits` / `getTaskDependents` / `finalizeAssignment`
- **RAG**：`searchMemberCommits` 內部用 Firestore vector search
- **自主決策**：Agent 自己決定要不要做 vector search、要不要查依賴下游

**`generateHandoffFlow`**（最完整的 Agentic 設計）：
- 包含上述所有概念，再加上：
- **Self Review**（類似 Heartbeat 的自我檢查）：Phase 2 用 GPT-4o-mini 對草稿評分，< 4 分回 Phase 1 重寫
- **7 個 Tools**：`readTeamRoster` / `findDownstreamTask` / `listRelatedCommits` / `getCommitDiff` / `searchDiscordMessages` / `searchPastCommits` / `draftHandoff` / `finalizeHandoff`

---

## 8. OpenClaw 額外機制（補充知識）

| 機制 | 說明 |
|---|---|
| **Context Engine** | 控制每次送給 model 的內容，有 `ingest` → `assemble` → `compact` → `afterTurn` 四個生命週期 |
| **Skill Workshop** | Agent 發現可重用模式時草擬 proposal，使用者審核後才寫入 SKILL.md |
| **Nested Sub-agents** | 最多 5 層深度（建議 2 層）— Main → Orchestrator → Worker |
| **Tool Policy** | 子代理預設拿不到 session tools，防止誤操作 |
| **Memory vs Context** | Memory 存在磁碟可跨 session 載入；Context 是當前 window 內的內容，兩者不同 |

---

> 本文件整理自課程投影片 + OpenClaw 官方文件。實作時以 [`ARCHITECTURE.md §5`](./ARCHITECTURE.md) 和 [`COURSE_METHODS.md §8`](./COURSE_METHODS.md) 為準。
