# GitSync AI Agents（內部 flow 一覽）

GitSync 內部自己設計的 AI agent 都放在 `functions/src/flows/`，用 OpenAI 寫成。
每個 flow 是**純業務邏輯**，本身不是 Cloud Function；由 `functions/src/handlers/`（callable / HTTP）
或 `functions/src/triggers/`（Firestore / scheduled）這層包成可部署的 function 後呼叫。

```
前端 / 排程 / Webhook
      │  (呼叫 callable，或事件觸發)
      ▼
index.ts 匯出的 function ── handlers/ 或 triggers/   ← 部署單位
      │  (呼叫)
      ▼
flows/*.ts  (AI 邏輯：prompt + tool loop + OpenAI)
      │  使用
      ▼
prompts/*.ts（system/user 提詞） + tools/*.ts（可重用能力）
```

共通設計：`MODELS.fast`、有界 round loop（`MAX_ROUNDS`，最後一輪強制無 tool 收尾）、
side-channel（如 `agentTrace`）與多數 tool 皆 best-effort，失敗不影響主 flow。

---

## 一次 agent 呼叫的組成（Sys. prompt / Metadata / Context）

每次送進 LLM（Runtime）的內容分三層。以 `askRepo` 為例（其他 flow 結構相同）：

```
┌─ Runtime（OpenAI 模型）──────────────┐
│  Sys. prompt   不太變、可被 cache 的「你是誰、怎麼做」 │
│  Metadata      這次 API call 的設定與可用工具          │
│  Context       這次/這輪實際要處理的資料               │
└──────────────────────────────────────┘
```

| 層 | 是什麼 | GitSync 對應 | 程式位置（askRepo） |
|---|---|---|---|
| **Sys. prompt** | 角色、能力、規則（穩定、可 prompt-cache） | `prompts/*.ts` 的 `role: 'system'` 字串 | `askRepoSystem(today, DEFAULT_DAYS)` — [askRepo.ts:254](../functions/src/flows/askRepo.ts#L254);全文見 [AI_AGENT_PROMPTS.md](AI_AGENT_PROMPTS.md) |
| **Metadata** | 送給 OpenAI 的參數，非對話內容本身 | `model` / `tools`(tool schema) / `tool_choice`，以及 `runId`、region、Node 版本等執行環境 | `model: MODELS.fast`、`tools: TOOLS`、`tool_choice: 'auto'` — [askRepo.ts:309-314](../functions/src/flows/askRepo.ts#L309-L314) |
| **Context** | 隨每輪變動、實際要處理的資料 | project brief 前綴 + history + 使用者 question + 每輪 tool 結果回灌 | brief [askRepo.ts:250](../functions/src/flows/askRepo.ts#L250)、history [askRepo.ts:255-258](../functions/src/flows/askRepo.ts#L255-L258)、question [askRepo.ts:259](../functions/src/flows/askRepo.ts#L259)、tool 結果 [askRepo.ts:332-334](../functions/src/flows/askRepo.ts#L332-L334) |

> 在 `summarizeDay` / `explainCommit` / `generateHandoff` 等 flow，Context 那層由
> `...Context()` / `...SeedContext()` 函式組出（如 `summarizeDayContext`、`explainCommitSeedContext`）。

---

## 每個 agent 的「角色」與 Context 設計

上面用 `askRepo` 說明三層通則；這裡逐一列出**各 flow 的角色（system 人設）**與
**Context 是怎麼組的**——差別主要在三件事：(a) 是否帶多輪 history、(b) 資料是「回灌
tool 結果」(agentic) 還是「一次 inline 進 prompt」(single-shot)、(c) 用哪個 model tier
與如何收尾（`finalizeX` / `writeX` / structured output）。

### 模式 A：多輪對話 agent（有 history，tool 結果逐輪回灌）

這類 Context = `system(+brief)` → 近 N 輪 history → 使用者 question → 每輪 `role:'tool'` 結果。

| Flow | 角色（system 人設） | Context 怎麼設計 | model / 收尾 |
|---|---|---|---|
| **askRepo** | repo 全知助手（progress / people / code / tasks / discussion） | system + **project brief 前綴** + history(≤8 輪) + question；每輪把 commits / Discord 等 read-only tool 結果回灌；commits/snippets 另收集成 source panel | `fast` / 模型不再呼叫 tool 即結束，達 round 上限則強制無 tool 收尾 |
| **dailyBriefChat** | 期間限定的 intelligence 助手（scope 綁 `period`） | 同上，但工具與資料**限定在 period 內**（跨時間才用 `searchPastCommits`） | `fast` / 同 askRepo |
| **discordChat** | Discord 對話問答（digest 優先、raw 訊息次之） | system + history + question；先回灌便宜的 `listDaySummaries/getDaySummary`，必要才回灌 `searchDiscordMessages` 的 raw snippet（可被 active window 時間限定） | `fast` / 同上 |

### 模式 B：Agentic 蒐證後產出（單一目標，無多輪 history，最後呼叫 write/finalize）

Context = `system` + 一段 **seed context**（要處理的對象），之後模型自己叫 tool 補證據，再用終結工具交件。

| Flow | 角色 | Context（seed）怎麼設計 | 收尾工具 / model |
|---|---|---|---|
| **assignTask** | 任務指派助手 | system + `briefPrefix + buildTaskBrief(task, members)`（task 內容 + 成員工作量/專長）；模型用 `readTeamState/searchMemberCommits/getTaskDependents` 補證據 | `finalizeAssignment(assigneeId, reason[, learnedTags])` 恰一次 / **`reasoning`** tier |
| **explainCommit** | 解釋單顆 commit | system + `explainCommitSeedContext`（commit message / 檔案 / AI 摘要 / linked tasks）；neighbors 與 Discord **不 inline**，由模型按需 `searchDiscordMessages/listNeighborCommits/getCommitDiff` 抓 | `writeExplanation(markdown)` / `fast`（無 doc 的 GitHub commit 走單次 fallback、無 tool） |
| **editDiscordDigest** | 就地改寫 digest | system + `editDiscordDigestSeed`（日期 + 現有摘要 + 指令）；需要證據才叫 `searchDiscordMessages/getDaySummary`，純改寫則不叫 | `writeDigest(markdown)` / `fast` |
| **generateHandoff** | **兩階段**：Phase 1 起草資深工程師 / Phase 2 嚴格 reviewer | Phase 1：system + `generateHandoffSeedContext`（接手 task + 驗收標準 + 已完成前置）；模型用 `listRelatedCommits/getCommitDiff/...` 蒐證 → `draftHandoff`。Phase 2 reviewer 收 draft+task 打分，gap 經 `handoffGapsFeedback` **回灌 Phase 1 線程**重寫 | Phase1 `gpt-4o` / Phase2 `gpt-4o-mini`；`score>=4` 即發布 |
| **summarizeDay** | 全團隊（含非技術者）的 intelligence reporter | system + `summarizeDayContext`（期間 + commits 最多 200 行 inline + 完成 tasks）；blocker/decision 由模型叫 `listRangeDigests`（缺才 raw） | `finalizeReport(summary/highlights/blockers/themes)` 恰一次；結尾另觸發 project brief merge / `fast` |

### 模式 C：單次 LLM 呼叫（資料一次 inline，無 tool loop）

Context = `system` + 一則把所有資料塞好的 `user` 訊息；一次回應即結果。

| Flow | 角色 | Context（user）怎麼設計 | 輸出 / model |
|---|---|---|---|
| **breakdownTask** | 資深工程師做淺層任務拆解 | `breakdownTaskUser(projectContext, goal)`：專案脈絡（常為整份 SPEC.md）+ 要拆的目標 | **structured output**（JSON：5–12 個 TODO + 0-based `dependsOn`）/ `fast` |
| **summarizeAuthorWork** | 中文「這個人做了什麼」整理者 | `summarizeAuthorWorkContext`：作者 + commit 總數 + 最新數筆（訊息/AI 摘要/增刪行） | 3–6 條中文 markdown bullet / `fast` |
| **discordDailyDigest** | 開發者聊天摘要器 | `discordDailyDigestUser(date, transcript)`：一天的 `authorName: content` 逐則訊息 | markdown digest / `fast`（`discordRangeDigest` 對區間逐日重用） |
| **triagePr** | PR 審查決策摘要者（reviewer 排名是**確定性演算法**，非 LLM） | system + `PR title / body / churn 前幾名檔案`（不重述完整檔案清單） | 3–5 行純文字摘要 / `fast` |
| **projectBrief merge** | 維護單一「專案記憶」的編輯者（重 KEEP/EVICT 反膨脹） | `projectBriefMergeUser(oldBrief, report)`：現有 brief + 今天的日報 | ≤500 字 markdown brief，覆寫 `meta/projectBrief` / `fast` |

---

## 一、Agentic 多輪 agent（模型自己呼叫 read-only tool 的 function-calling loop）

| Flow（`flows/`） | 角色 | 主要 tools | 被誰呼叫（function） | 觸發來源 |
|---|---|---|---|---|
| **askRepo** | 統一的 repo-wide「問什麼都行」agent，取代各分頁聊天 | recent commits / completed tasks / Discord digests / 語意搜尋(commit+Discord) / planning docs / task dependents / team roster | `askRepo` (onCall) | 前端 `functions_service.askRepo()` |
| **assignTask** | 挑出 task 最佳負責人，並自動寫入 assignee + rebalance `activeIssueCount` | `assignTools`（team state / member commits / learned tags） | `assignTask` (onCall)；`onTaskUpdated` (Firestore trigger) | 前端手動指派；task 更新時自動指派 |
| **dailyBriefChat** | Summary 分頁「問 AI 今天發生什麼」聊天 | 當天活動的 read-only tools | `dailyBrief` (onCall) | 前端 `functions_service.dailyBrief()` |
| **discordChat** | 回答關於團隊 Discord 對話的問題 | `searchDiscordMessages` | `discordChat` (onCall) | 前端 `functions_service.discordChat()` |
| **explainCommit** | 點 commit tree 上某顆 commit → AI 解釋這次工作 | `searchDiscordMessages` / `listNeighborCommits` … | `explainCommit` (onCall) | 前端點 commit |
| **summarizeDay** | 對某日期區間產 agentic 報告（commits + 完成 task + Discord），並滾動更新 project brief | day-scoped read-only tools | `summarizeDay` (onCall)；`dailyReportWorker` (onTaskDispatched / Cloud Task) | 前端手動；每日 cron `scheduledDailyReport`（`0 18 * * *`）enqueue worker |
| **generateHandoff** | 為接手 task 的工程師產交接文件，以前置任務的真實訊號為依據 | `handoffTools` | `generateHandoff` (onCall)；`onTaskUpdated` (Firestore trigger) | 前端手動；task 進入可接手狀態時自動 |
| **editDiscordDigest** | 依自然語言指令就地改寫 Discord daily digest | digest 讀寫 | `editDiscordDigest` (onCall)；`botEditDigest` (onRequest) | 前端「請 AI 調整摘要」；Discord bot 指令 |

## 二、單次 LLM 任務（structured output / 一次性摘要，非多輪 tool loop）

| Flow（`flows/`） | 角色 | 被誰呼叫（function） | 觸發來源 |
|---|---|---|---|
| **breakdownTask** | 把目標拆成 5–12 個 high-level subtask（structured output；預先產 Firestore taskId 把 0-based `dependsOn` 轉成真 id） | `breakdownTask` (onCall) | 前端 `functions_service.breakdownTask()` |
| **summarizeAuthorWork** | 進度表「這個人做了什麼?」的短 markdown 摘要 | `summarizeAuthorWork` (onCall) | 前端點某成員 |
| **discordDailyDigest** | 讀一天的 Discord 訊息產出 markdown digest | `completeDiscordFetch` (onRequest) | Discord bot 完成 fetch 後回呼 |
| **discordRangeDigest** | 對 backfill 區間每天各產一份 digest | `completeDiscordFetch` (onRequest) | 同上（backfill 區間） |
| **triagePr** | PR triage agent 核心邏輯（純 flow，不寫 Firestore） | `onPullRequestOpened` (Firestore trigger) | PR 開啟事件 |

> `flows/getCommitGraph` 不是 AI flow：它用 GitHub API 組 commit 拓樸圖，由 `getCommitGraph` (onCall) 呼叫，列此僅作釐清。

---

## 一個 task 被自動指派的完整鏈（範例）

```
使用者在 App 更新 task 狀態
  → Firestore 寫入 tasks/{id}
  → onTaskUpdated (Firestore trigger)
      → assignTaskFlow      （挑負責人 + 寫回 assigneeId）
      → generateHandoffFlow （產交接文件）
```

## 每日報告鏈（範例）

```
scheduledDailyReport (cron 0 18 * * *)
  → 掃所有 repo，每個 repo enqueue 一個 Cloud Task
  → dailyReportWorker (onTaskDispatched)
      → summarizeDayFlow → 同時滾動更新 meta/projectBrief（專案記憶）
```
