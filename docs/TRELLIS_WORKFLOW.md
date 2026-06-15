# GitSync Trellis 團隊協作流程

> 這份是給**整個團隊**的 Trellis 使用約定。Trellis 把每一項「要動到 code 的工作」包成一個 **task**，走「規劃 → 執行 → 收尾」三階段，並把需求文件與踩雷經驗沉澱成全團隊共享的知識庫。
>
> 新機器第一次設定環境請先看 [`SETUP.md`](./SETUP.md)；這份只談「我們團隊怎麼用 Trellis 一起開發」。

---

## 0. 核心心智模型

Trellis 的檔案分兩種，這決定了團隊怎麼協作：

| 類型 | 路徑 | 進 git？ | 意義 |
|---|---|:---:|---|
| **共享** | `.trellis/tasks/` · `.trellis/spec/` · `workflow.md` · `config.yaml` | ✅ 會 | 需求文件 + 團隊規範，大家看同一份 |
| **共享（各自子目錄）** | `.trellis/workspace/<你>/` | ✅ 會 | 你的 journal / session 紀錄；每人一個子資料夾，所以不會互相覆蓋 |
| **本機** | `.trellis/.developer` · `.current-task` · `.runtime/` · `.agents/` | ❌ gitignore | 你的身份與「當前進度」指標，純本機 |

> **一句話**：身份與「當前指向哪個 task」是純本機（gitignore）；task 內容、spec 知識庫、各人的 journal 都是進 git 共享的。
> journal 雖然共享，但每人寫在自己的 `workspace/<你>/` 子目錄，所以兩個人同時開發不會撞。

---

## 1. 首次設定（每人各自一次／每台機器）

在你自己的 clone 初始化開發者身份：

```bash
python ./.trellis/scripts/init_developer.py <你的名字>
# 例: alice / bob / opal —— 名字團隊內要唯一
```

這會建立 `.developer`（純本機、gitignore）與 `workspace/<你的名字>/`（你個人的 journal，會進 git，但因為是各自的子目錄所以**不會互相覆蓋**）。

驗證：

```bash
python ./.trellis/scripts/get_developer.py    # 印出你的名字 = OK
```

> 開新 session 時若看到 `ERROR: Not initialized`，就是這步沒做。

---

## 2. 一個工作項目的完整生命週期

我們採 **git-flow 風格分支**：`main`（穩定可 demo）← `develop`（整合）← `feature/*`（單一功能 / 單一 task）。完整規則見 [`.trellis/spec/guides/git-workflow.md`](../.trellis/spec/guides/git-workflow.md)（這是 Trellis spec，AI 在 commit 階段會自動遵守）。

```bash
# 0) 切到 develop 並同步
git checkout develop
git pull --rebase

# 1) 從 develop 開 feature 分支（slug 對齊 task）
git checkout -b feature/some-feature

# 2) 建 task（進入「規劃」階段；先別跑 start）
python ./.trellis/scripts/task.py create "做某某功能" --slug some-feature
```

> **永遠不要直接在 `main` / `develop` 上寫功能 code。** 功能做完、check 過 → `git merge --no-ff` 回 `develop`；`develop` 累積到可 demo → 才合併進 `main`。

接著照三階段走：

### Phase 1 規劃
1. **釐清需求** — 載入 `trellis-brainstorm` skill，AI 一題一題問，把結論寫進 `prd.md`。
2. **（可選）研究** — 比較工具 / 查外部文件時，派 `trellis-research` sub-agent，findings 會寫到 `{task}/research/`。
3. **設定 context** — 編輯 task 目錄下的 `implement.jsonl` / `check.jsonl`，列入相關 spec 檔案（給 Phase 2 的 sub-agent 用）。
4. **啟動 task**：
   ```bash
   python ./.trellis/scripts/task.py start <task-dir>
   ```

### Phase 2 執行
1. **實作** — 派 `trellis-implement` sub-agent，它會自動載入 jsonl 指定的 spec + `prd.md`。
2. **品質檢查** — 派 `trellis-check` sub-agent，對照 spec 檢查並修正，跑 lint / type-check。

### Phase 3 收尾
1. **最終驗證** — 再跑一次 `trellis-check`，直到全綠。
2. **沉澱知識** — 載入 `trellis-update-spec`，把這次學到的慣例 / 踩到的雷寫進 `.trellis/spec/`。
3. **commit** — 把 code + task 文件一起 commit。
4. **歸檔** — 跑 `/finish-work`（或 `trellis:finish-work` skill）封存 task、記錄 session。

最後開 PR，review 通過再 merge 回 `main`。

---

## 3. 團隊要遵守的約定

| 主題 | 約定 | 為什麼 |
|---|---|---|
| **身份命名** | 每人 `init_developer` 用團隊內唯一名字 | journal / workspace 才不會混 |
| **分支策略** | `feature/*` ← `develop` ← `main`；1 task = 1 feature 分支 | 見 [git-workflow.md](../.trellis/spec/guides/git-workflow.md)；develop 當整合區，main 保持可 demo |
| **避免撞 task** | 開 task 前 `git pull --rebase`，看 `.trellis/tasks/` 有沒有人在做同領域 | tasks 是共享目錄，避免兩人改同一塊 |
| **push 紀律** | push 前 `git pull --rebase` | journal 自動 commit（見 §4），rebase 可避免衝突 |
| **spec 更新** | 每個 PR 都問「這次學到什麼該寫進 spec？」 | spec 是團隊唯一不會流失的記憶 |
| **需求落地** | 任何需求一律寫進 `prd.md`，不要只留在對話 | 對話會被壓縮，檔案不會 |

---

## 4. 關於 journal 自動 commit

`.trellis/config.yaml` 的 `session_auto_commit` 目前為**預設（true）**：每次 session 收尾會自動 commit 你的 journal（`chore: record journal`）。

- 好處：零手動操作，工作紀錄一定不漏。
- 注意：多人同時 push journal 偶爾會撞 → **push 前先 `git pull --rebase`** 即可化解（journal 是各自 `workspace/<你>/` 下的獨立檔案，幾乎不會真衝突）。

> 之後若覺得 `chore: record journal` 洗版太多，可把 `session_auto_commit` 改成 `false` 改為手動 commit。

---

## 5. 常用指令速查

```bash
# 我現在在哪個 task
python ./.trellis/scripts/task.py current

# 列出所有 package + 對應 spec 層（挑要放進 jsonl 的）
python ./.trellis/scripts/get_context.py --mode packages

# 查某個流程步驟的詳細指引
python ./.trellis/scripts/get_context.py --mode phase --step 1.1

# 確認自己的開發者身份
python ./.trellis/scripts/get_developer.py
```

Skill 路由（符合下列意圖時先載入對應 skill，不要跳過）：

| 意圖 | Skill / Sub-agent |
|---|---|
| 想做新功能 / 需求不明 | `trellis-brainstorm` |
| 要開始寫 code | 派 `trellis-implement` sub-agent |
| 寫完想驗證 | 派 `trellis-check` sub-agent |
| 同一個 bug 修了好幾次 | `trellis-break-loop` |
| 有新慣例要記錄 | `trellis-update-spec` |

---

## 6. 什麼時候「不用」開 task？

- **純問答 / 查資料 / 不改檔案** → 直接做，不必建 task。
- **任何要改 code / 重構 / 加功能** → 一律走上面的流程。
- 想單次跳過流程做小修 → 在訊息裡明講「直接改 / skip trellis」。

---

## 7. 還有問題？

- Trellis 完整流程細節：[`.trellis/workflow.md`](../.trellis/workflow.md)
- 環境設定：[`SETUP.md`](./SETUP.md)
- AI agent 規範：[`AI_AGENT_RULES.md`](./AI_AGENT_RULES.md)
- 團隊決策紀錄：[`MEMORY.md`](./MEMORY.md)
