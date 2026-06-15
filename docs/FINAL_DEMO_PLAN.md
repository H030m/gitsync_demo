# Final Demo 執行計畫 v2（已定案版）

> 評分：Agentic design 30% · Completeness 30% · The "hard" parts 20% · UX & UI 20%
> 3 分鐘 demo · 6/18 · 今天 6/12，剩 6 天
> 本版整合決策：✅ 方案 A（agentic 交接文件）、✅ 強化 commit/Discord 內容搜尋、✅ Agent 隨專案進展累積理解（專案記憶）、✅ Agent 讀 repo 內 .trellis/.claude 理解進度、✅ UX 主軸＝「agent 取代頁面，降低學習成本」。FCM 由他人完成，僅待 merge，不在本計畫內。

---

## 0. 整體敘事（demo 的一句話主軸）

**「GitSync 不是在 App 裡加一個 AI 功能，而是用 agent 取代了一整批本來要做的頁面——你不用學怎麼查、怎麼篩、怎麼整理，開口問就好；而且 agent 會隨著專案推進越來越懂你的專案和你的隊友。」**

五個工作項都收斂到這句話：
- W1 agentic 交接文件 → agent 取代「寫文件」這件事本身
- W2 語意搜尋強化 → agent 的「眼睛」變利，是 W1/W5 的地基
- W3 專案記憶 → 「越用越懂」的證據（Agentic Map 的 Memory 箱）
- W4 讀 .trellis/.claude → agent 直接吸收團隊既有的規劃文件，零額外輸入成本
- W5 統一問答入口 → 「不用設計分類頁/查詢頁」的 UX 主張落地

---

## W1：交接文件升級為 Agentic（方案 A）——最高優先

**目標**：兌現期中投影片核心功能 03 的兩個 agentic 承諾——「自主檢索 Project 技術細節」＋「自我審查直到夠好才發布」。

**現況**：`functions/src/flows/generateHandoff.ts` 是確定性預取 + 一次 `gpt-4o-mini` 呼叫，無工具循環、無審查（檔頭註解自承）。

**設計**（兩階段，骨架直接複用 `flows/assignTask.ts` 的工具循環）：

```
Phase 1 草擬循環（gpt-4o，最多 4 輪，tool_choice: auto）
  工具（read-only，多數已存在）：
    - listRelatedCommits(taskId)      ← 抽出現有 linkedTaskIds 查詢邏輯
    - getCommitDiff(sha)              ← 新增，包 githubClient.getCommit（REST 已有）
                                         diff 截斷上限 ~3000 tokens/commit
    - searchDiscordMessages(query)    ← 既有；W2 完成後自動變語意搜尋
    - searchPastCommits(query)        ← 既有向量搜尋
    - readRepoPlanningDocs()          ← W4 的新工具（讀 .trellis prd / AGENTS.md）
    - readTeamState(repoId)           ← 既有
  終止工具：draftHandoff(markdown)

Phase 2 自我審查（gpt-4o-mini，每輪草稿一次）
  輸入：草稿 + 下游任務的 acceptanceCriteria + 任務描述
  輸出（zod structured output）：{ score: 1-5, gaps: string[] }
  score >= 4 → finalize，寫入 tasks/{taskId}.handoffDoc
  score < 4 且總輪數 < 5 → 把 gaps 注入 messages，回 Phase 1 繼續挖
  總輪數達 5 → 強制收斂：tool_choice 鎖定 draftHandoff，採用最後一版
```

**保留既有行為**：`handoffDoc` 快取語意不變（auto trigger `force=false` 跳過已存在；手動 callable `force=true` 重生）；`onTaskUpdated` 觸發路徑不動；失敗 best-effort 不擋其他下游任務。

**檔案**：改 `flows/generateHandoff.ts`、`prompts/generateHandoff.ts`（加 reviewer prompt）、`tools/` 新增 `getCommitDiff`；jest boundary-mock 測試比照 `assignTask` 既有測試。

**估時**：1.5 天。**風險**：diff 太大爆 context → 截斷＋只給 agent 它點名要的 commit；延遲變長（10→30 秒）→ 用 W5 的工具軌跡顯示把等待變成展示。

**評分對應**：Completeness（期中承諾兌現）＋ Agentic design（self-review 是第二個 sub-agent 範例）＋ Hard parts（防無限迴圈：全域輪數上限＋末輪 tool_choice 強制收斂；review 分數門檻的收斂設計）。

---

## W2：Commit ＋ Discord 內容搜尋強化——W1/W5 的地基，第二優先

**目標**：讓所有 agent 的檢索從「關鍵字」升級為「語意優先、關鍵字兜底」，並補齊歷史資料的向量。

### W2a. Discord 訊息向量化（補 stub）
- `triggers/onDiscordMessageCreated.ts:29-33` 目前只有噪音過濾，TODO 註明 embedding 未做。補上：呼叫 `tools/embedding.ts` 的 `embed()` → `FieldValue.vector()` 寫入 `discordMessages/{id}.embedding`（照抄 `onCommitCreated` 的既有路徑）。
- `firestore.indexes.json` 的 discordMessages 向量索引已預留，部署即可。
- 順手做（可選）：mini 模型推斷 `linkedTaskIds`（structured output），讓 Discord 討論能連回任務——交接文件檢索會更準。

### W2b. `searchDiscordMessages` 升級
- `tools/discordSearch.ts`：改為向量 `findNearest`（COSINE, limit 10）優先；無 embedding 命中或查詢失敗時 fallback 回現有關鍵字＋recency 排序（degrade gracefully，符合既有 Rule D 風格）。回傳結構不變，上游（discordChat、W1、W5）零改動。

### W2c. `searchPastCommits` 統一為向量
- 現況不一致：`assignTask` 的 `searchMemberCommits` 走向量，但 `dailyBrief`/`summarizeDay` 的 `searchPastCommits` 是關鍵字。統一成向量優先（commits 的 embedding 與索引早已存在）、關鍵字兜底。

### W2d. 歷史資料回填（backfill）
- 既有訊息/commit 沒有 embedding 的（stub 期間入庫的 Discord 訊息、graph 回填的舊 commit），寫一個一次性 callable `backfillEmbeddings({repoId, collection})`：分批掃描缺 embedding 的 doc → 過噪音濾網 → embed → 寫回。冪等（已有 embedding 即跳過），batch 50 筆防 timeout。
- demo 前對演示 repo 跑一次即可，不必做排程版。

**估時**：合計 1 天（a+b 半天、c 0.25、d 0.25）。**評分對應**：Completeness（期中 Q&A「AI 掌握 Discord 討論」的承諾）＋讓 W1/W5 的檢索品質撐得起現場 demo。

---

## W3：專案記憶——Agent 隨專案進展越來越懂專案

**目標**：給 Agentic Map 最弱的 Memory 箱一個「會成長」的故事，且所有 flow 共享。

### W3a. 滾動式專案簡報（Project Brief）——核心
- 新增 doc：`repos/{repoId}/meta/projectBrief`（欄位：`content`（≤500 字 markdown）、`updatedAt`、`version`）。
- **寫入**：`summarizeDayFlow` 完成日報後追加一步——mini 模型拿「舊 brief ＋ 今日報告」做 merge-summarize：「把今天學到的架構決策、慣例、反覆出現的 blocker 合併進專案簡報，總長不得超過 500 字，過時資訊要淘汰」。每天 18:00 cron 自動演進，也隨手動 regenerate 更新。
- **讀取**：`breakdownTask`、`assignTask`、`generateHandoff`（W1）、`askRepo`（W5）的 context 組裝統一前置這份 brief（放 system/context 前綴，吃 prompt cache 折扣）。
- **這就是「agent 隨專案進展更了解專案」的直接實作**：第 1 天 brief 是空的，第 10 天它知道你們的慣例、痛點、技術選型。demo 可以直接把 brief 內容秀出來。

### W3b. 成員專長自動學習
- `assignTaskFlow` 的 `finalizeAssignment` 擴充：agent 在 finalize 時額外輸出 `learnedTags: string[]`（從它檢索到的 commit 證據歸納），merge 進 `members/{userId}.expertiseTags`（arrayUnion，上限 8 個 tag 防膨脹）。
- 下次指派 `readTeamState` 讀回——**agent 的上次決策成為下次輸入**。一句 demo 詞：「每指派一次，系統就更了解每個人一分」。

**估時**：a 0.5 天、b 0.5 天。**Hard part 素材**：滾動摘要怎麼不無限膨脹（merge-summarize ＋字數上限＋淘汰指令）；記憶寫入點為什麼選在 cron 日報（已是全資訊匯流點，零額外排程）。

---

## W4：Agent 讀 repo 內的 .trellis / .claude——快速理解進度

**目標**：團隊本來就在 repo 裡維護 `.trellis/`（task.json、prd.md）、`AGENTS.md`、`.claude/`、`docs/`——agent 直接讀這些，等於**零成本吸收整個專案的規劃脈絡**。這也是 demo 的彩蛋：拿 GitSync 自己的 repo 演示，agent 讀自己的 .trellis 回答「目前進度 53/54 個 task 完成，唯一未結案的是 FCM 通知」。

**設計**：新工具 `readRepoPlanningDocs(repoId)`（`tools/repoDocs.ts`）：
1. 用 repo 擁有者的 `githubAccessToken` 走 GitHub contents API。
2. 讀取優先序（總量上限 ~8000 tokens，超過截斷）：
   - `.trellis/tasks/*/task.json`（只取 title/status，彙整成進度清單）＋ active task 的 `prd.md`
   - `AGENTS.md` / `CLAUDE.md`（根目錄）
   - `.claude/` 下的 md 檔（只列檔名＋前 50 行）
   - 都沒有時 fallback：`README.md` ＋ `docs/` 目錄清單
3. **快取**：結果存 `repos/{repoId}/meta/repoDocsCache`（TTL 10 分鐘），防 GitHub rate limit、也讓同一場 demo 內重複呼叫零延遲。
4. **掛載點**：作為工具提供給 W1（交接文件了解任務脈絡）、W5（問答）、`breakdownTask`（拆解時知道哪些已做過，避免重複拆已完成的工作——這直接強化期中核心功能 01 的「讀取專案上下文」）。

**安全注意**：只讀 markdown/json、單檔上限 30KB、不讀 `secrets/`、`.env`；文件內容進 prompt 前不進 log。

**估時**：0.5–1 天。**評分對應**：Agentic design（Tools 箱多一個有記憶體感的工具）＋ UX（使用者不用在 app 裡重新輸入任何專案背景）＋ demo 彩蛋自我指涉效果極佳。

---

## W5：統一問答入口——「Agent 取代頁面」的 UX 主張

**目標**：UX 20% 的答題核心不是畫更多 UI，而是證明「**因為有 agent，我們不需要做分類頁、查詢頁、篩選器、報表設定頁**——使用者的學習成本趨近於零」。

**現況問題**：問答能力被拆在兩個角落（Summary tab 的 dailyBrief 聊天、Discord tab 的 discordChat 聊天），各自只有自己的工具組——使用者得先學「哪種問題去哪個 tab 問」，這恰恰違反我們自己的主張。

**設計**：
1. 後端新 flow `askRepo`（`flows/askRepo.ts`）：合併工具全集——
   `listDayCommits`、`listCompletedTasks`、`listRangeDigests`、`searchPastCommits`（W2c 向量版）、`searchDiscordMessages`（W2b 向量版）、`readRepoPlanningDocs`（W4）、`getTaskDependents`、roster——mini 模型，最多 5 輪，回答附引用來源（commit/訊息/任務，沿用現有 sources 結構）。context 前綴掛 W3a 的 projectBrief。
   - 實作上就是 `dailyBriefChatFlow` 的擴充版：複製骨架、擴工具表、調 system prompt（「你是這個 repo 的全知助理，回答任何關於進度、人、程式碼、討論的問題，一律引用證據」）。
2. 前端：全域懸浮入口（每頁右下 FAB 或 AppBar 圖示）開啟同一個聊天 sheet；既有兩個 tab 內嵌聊天改接同一個 `askRepo`（保留 UI 位置，後端統一）。
3. **工具軌跡即時顯示**（強烈建議一起做）：flow 每執行一個工具寫一行進度到 `repos/{repoId}/agentRuns/{runId}`，前端串流顯示「正在讀取 .trellis 進度… → 正在搜尋相關 commit… → 正在比對 Discord 討論…」。
   - 等待 10–30 秒不再是空白 spinner（UX）；評審**親眼看到 agent 自主選工具**（Agentic 活證據）；「callable 不能 stream，用 Firestore 當 side-channel 回傳進度」本身是 hard part 巧思。
   - 至少覆蓋 `askRepo` 和 W1 的 handoff（這兩個最慢、也最值得展示）。

**Demo 講法（UX 段的台詞）**：「左邊是傳統做法要做的頁面：搜尋頁、篩選器、報表設定、文件範本——我們一個都沒做。取而代之的是一個入口：你問『上週誰動過碰撞偵測？卡在哪？』它自己決定去翻 commit、翻 Discord、翻 .trellis，給你帶引用的答案。使用者要學的 UI = 一個輸入框。」

**估時**：後端 0.5 天（骨架是抄的）、前端 0.5 天、工具軌跡 0.5 天，合計 1.5 天。

---

## 不做 / 移出範圍

| 項目 | 處置 |
|---|---|
| FCM 推播 | 他人完成，**只待 merge**。merge 後把「拖 Done → 隊友手機推播 → 點開交接文件」排進 demo 動線並實機排練一次 |
| Agent 活動 feed（v1 計畫的 §2.6） | **降級為可選**。UX 主張已由 W5「取代頁面」承擔；若 W5 提早完成可加回，feed 資料源可直接用 agentRuns |
| 聊天記錄持久化、digest lock UI、handoff 重生按鈕 | 低優先。handoff 重生按鈕若 W1 完成順手加（callable 已支援 force=true，純前端 10 行） |
| Web FCM、token 加密、expertiseTags 之外的 ML | 維持 post-demo |

---

## 時程與分工（6/12–6/17，6/18 demo）

依賴關係：**W2 是 W1/W5 的地基，先做**；W4 是獨立工具，可平行；W3a 依賴日報 flow（獨立可平行）；W5 收尾整合所有工具。

| 日期 | 工作 | 產出檢查點 |
|---|---|---|
| 6/12（今） | W2a+b（Discord embedding＋向量搜尋）、W4 動工 | Discord 新訊息有 embedding；searchDiscordMessages 向量優先 |
| 6/13 | W2c+d（commit 向量統一＋backfill）、W4 完成、W1 動工 | 演示 repo backfill 跑完；readRepoPlanningDocs 可回傳 .trellis 進度 |
| 6/14 | W1 主體（Phase 1 工具循環＋Phase 2 review） | handoff 在 live 後端跑通一次，輪數/分數寫進 log |
| 6/15 | W1 收尾＋測試、W3a+b（專案記憶） | projectBrief 首次生成；指派後 expertiseTags 有寫回 |
| 6/16 | W5（askRepo＋全域入口＋工具軌跡） | 任一頁開聊天，問進度類問題答案帶引用；軌跡逐行浮現 |
| 6/17 | FCM merge、端到端排練 ×3、demo 腳本定稿、備援錄影 | 3 分鐘掐錶過三次；錄一支備援影片防現場網路 |

5 人分工建議：W1（1 人，最重）、W2（1 人）、W4＋W3（1 人）、W5 後端＋前端（1–2 人）、腳本/投影片/排練統籌（1 人，6/16 起全員）。

---

## 3 分鐘 Demo 腳本（v2）

**0:00–1:00 Service ＋ Agentic Map 對應**（照教授建議格式）
- 15 秒：「GitSync：拆任務、派任務、寫交接、做日報、回答任何專案問題——全由 agent 代勞，使用者要學的 UI 只剩一個輸入框。」
- 45 秒指圖：五種輸入全有（User callable／Cron 18:00 日報／Heartbeat 解鎖看門狗／GitHub+Discord 外部事件／任務完成內部事件鏈）→ 兩條 queue（Cloud Tasks fan-out、手作 fetchRequests 狀態機）→ Runtime（九組 system prompt、確定性 context、repoId+三方 ID metadata）→ Tools（向量搜尋、diff、**讀 repo 的 .trellis**）→ Sub-agents（每 repo 一個日報 worker、**handoff 的 reviewer**）→ **Memory（embeddings ＝長期記憶；projectBrief 每天演進＝專案理解；expertiseTags 寫回＝對人的理解）** → LLM 分級（4o 推理／mini 摘要）。
- 課堂連結一句帶過：分層即課程 Gateway/Brain/Tools/Skills/Memory 框架（docs/AGENTIC_CONCEPTS.md）。

**1:00–2:10 Completeness 走一圈**（live，動線＝期中三大功能＋新能力）
1. 貼目標 → AI 拆解（讀過 .trellis，不重複拆已完成項）→ 確認 → 關聯圖上板【核心功能 01 ✓】
2. 自動指派 → 工具軌跡逐行浮現 → 指派完成＋理由＋「學到的專長已寫回」【核心功能 02 ✓＋Memory】
3. 前置任務拖到 Done → 隊友手機跳推播 → 點開 agentic 交接文件（提一句：自我審查 2 輪、第一輪 3 分被退回）【核心功能 03 ✓】
4. 全域問答：「上週誰動過 XX？現在卡在哪？」→ 軌跡顯示它翻了 commit/Discord/.trellis → 帶引用回答【W5】
5. 10 秒帶過 Daily 三 tab／Stats／i18n。

**2:10–3:00 Hard parts ×2 ＋ UX 收尾**
- Hard part ①：LLM 不知道還沒存在的 ID → index 翻譯＋DFS 循環偵測＋自我修正重問。
- Hard part ②（從 W1 現挑）：self-review 怎麼保證收斂——分數門檻＋全域輪數上限＋末輪 tool_choice 強制終止；或滾動專案記憶怎麼不膨脹。
- UX 收尾：「這些畫面我們沒有做：搜尋頁、篩選器、報表設定、文件範本——因為 agent 把它們全部變成一句話的事。」

備用 Q&A 口袋：idempotency at-least-once、分散式鎖＋heartbeat、snowflake watermark、不讓 LLM 數數、模型分級＋prompt cache 省成本。

---

## 驗證清單（6/17 全勾）

- [ ] 期中三大核心功能在 **live 後端**各完整跑通（非 fake mode）
- [ ] W1：handoff 至少出現過一次「review 退回再挖」的真實案例（log 留存，demo 可引述）
- [ ] W2：演示 repo backfill 完成；用語意問法（非關鍵字）測 Discord/commit 搜尋各 3 題
- [ ] W3：projectBrief 已演進至少 2 個版本；指派一次後 expertiseTags 有新 tag
- [ ] W4：對 gitsync 自己的 repo 問「目前進度」，答案正確引用 .trellis
- [ ] W5：三種類型問題（進度／人／技術細節）都帶正確引用；工具軌跡正常浮現
- [ ] FCM merge 後實機推播一鏡到底排練過
- [ ] Firestore rules 6/25 才到期，demo 不受影響；**不要**在 demo 前誤部署嚴格規則
- [ ] OpenAI 額度確認；備援：手機熱點＋預錄影片
- [ ] 3 分鐘掐錶排練 ×3

---

## 分支與 Merge 計畫（2026-06-12 記錄）

### 現況快照
- `origin/main`：領先 develop 1 個 commit（`6a70a97` revert: move 7 UI commits to develop）——**develop→main 的 PR 衝突來源，由他人解決，我們不碰**。
- `origin/develop`（`92f858a`）：領先 main 157 個 commit，是所有新工作的基底。
- `feature/foreground-notifications`：FCM 工作分支（與他人共用），含 4 個未進 develop 的 commit；改了 `app_strings.dart`／`daily_view_page.dart`／`settings_page.dart`，與 develop 的 i18n 系列重疊，merge develop 時會有小衝突（與 main 大衝突無關）。

### 本次工作的分支結構（全部由 Claude 操作，不汙染既有分支）
```
origin/develop (92f858a)
  └── feature/agentic-final-demo        ← 整合分支（最終 push，之後對 develop 開 PR）
        ├── feat/w2-semantic-search     ← W2（Opus 實作）
        ├── feat/w4-repo-docs           ← W4（Opus 實作）
        ├── feat/w1-agentic-handoff     ← W1（等 W2 合入後從整合分支開）
        ├── feat/w3-project-memory      ← W3
        └── feat/w5-ask-repo            ← W5（最後，整合所有工具）
```
每個分支用獨立 git worktree（`ssfinal/gitsync-w2`、`gitsync-w4`…）避免互踩；衝突由 Fable 5 處理。

### 之後需要的 merge（依序）
1. 【他人】develop → main 的 PR（衝突解法會內建在 merge commit 裡）。
2. 【他人/使用者】`feature/foreground-notifications` merge `origin/develop`（20 commits，i18n 小衝突）→ 之後 PR 進 develop。
3. 【Claude】feat/w2、feat/w4 → `feature/agentic-final-demo`（W2 先，W1 依賴它）。
4. 【Claude】feat/w1、feat/w3 → `feature/agentic-final-demo`。
5. 【Claude】feat/w5 → `feature/agentic-final-demo` → push。
6. 【使用者拍板】`feature/agentic-final-demo` → develop 的 PR，**等第 1 項落地後再開**，屆時 merge 最新 develop 即自動繼承大衝突的解法。

### 工作流程（每個工作項）
1. Opus 開 trellis task（task.json + prd.md，比照 archive 既有格式）＋ 寫工作計畫 → **停**。
2. Fable 5 審查計畫，OK 才放行改 code（Opus 有不清楚的，Fable 5 按本計畫回答；Fable 5 也不知道才問使用者）。
3. Opus 實作 → 自我審查（lint/typecheck/test ＋ code review）→ 回報。
4. Fable 5 最終確認 → 關閉 trellis task → commit/push 該分支 → merge 進整合分支。
5. Session 紀錄寫進 `docs/journal/113062210_chiajun.md`。

## 仍待你們拍板

1. **demo 用哪個 repo**：建議直接用 gitsync 自己的 repo（資料最豐富＋W4 自我指涉彩蛋），但要先確認 .trellis 內沒有不想公開投影的內容。
2. W2a 的「Discord 訊息推斷 linkedTaskIds」做不做（可選項，+0.25 天，讓交接檢索更準）。
3. W5 的全域 FAB 放哪、要不要同時保留兩個 tab 內的舊聊天框（建議保留、後端統一）。
4. 工具軌跡顯示的文案用中文還是英文（UI 目前全英文＋i18n，建議走 l10n）。
