# Git Workflow Convention

> **Scope**: This is a binding convention for this project — the AI and all team
> members must follow it when creating branches, committing, and merging.
> It governs Phase 3.4 (commit) of the Trellis workflow.

---

## Branch Model (git-flow style)

```
main      ← 穩定、隨時可 demo 的版本。只接受來自 develop 的合併。
  ▲
develop   ← 整合分支。所有功能在這裡匯流。日常開發的「家」。
  ▲
feature/* ← 單一功能 / 單一 Trellis task。從 develop 開，做完 merge 回 develop。
fix/*     ← 修 bug，同樣從 develop 開、merge 回 develop。
```

**核心規則**：

1. **永遠不要直接在 `main` 或 `develop` 上寫功能 code。**
2. 每個 Trellis task → 從 `develop` 開一條新分支。
3. 功能做完、`trellis-check` 過 → merge 回 `develop`。
4. `develop` 累積到一個穩定、可 demo 的里程碑 → 才合併進 `main`。

---

## 分支命名

分支名對齊 Trellis task 的 `--slug`，方便追溯：

| 類型 | 命名 | 範例 |
|---|---|---|
| 功能 | `feature/<slug>` | `feature/add-repo-callable` |
| 修 bug | `fix/<slug>` | `fix/board-drag-crash` |

---

## 一個 task 的 git 生命週期

```bash
# 1) 先同步 develop
git checkout develop
git pull --rebase

# 2) 從 develop 開 feature 分支（slug 對齊 task）
git checkout -b feature/<slug>

# 3) 建 Trellis task，走 Phase 1→3
python ./.trellis/scripts/task.py create "<title>" --slug <slug>
#    ... brainstorm → prd → implement → check ...

# 4) Phase 3.4：在 feature 分支上 commit（依下方 Commit 規範）

# 5) merge 回 develop（保留 merge 節點，歷史看得出這是一個 feature）
git checkout develop
git pull --rebase
git merge --no-ff feature/<slug>
git push

# 6) （可選）刪掉已合併的 feature 分支
git branch -d feature/<slug>
```

> 若團隊用 GitHub PR review：步驟 5 改成開 PR，**base 設成 `develop`**（不是 main），review 通過再 merge。

---

## Commit 規範（對齊 Trellis Phase 3.4）

- 訊息前綴沿用 repo 慣例：`feat:` / `fix:` / `chore:` / `docs:` …
- 一個 commit = 一個邏輯變更單位，不要一檔一 commit。
- 只 commit 這次 session AI 改過的檔；不認得的 dirty 檔要先跟使用者確認。
- 不 `git commit --amend`、不在這步 push 到 `main`。

---

## develop → main 的時機

只有在 `develop` 達到「可 demo / 可交付」狀態才合併進 main：

```bash
git checkout main
git pull --rebase
git merge --no-ff develop
git push
```

對應 ARCHITECTURE.md 的 Sprint 里程碑 —— 每個 Sprint 收尾、demo 前，是把 develop 合進 main 的自然時間點。

---

## 持續累積的注意事項（Living Conventions）

> **這份文件是團隊 git/流程注意事項的累積處。**

每當開發中發現新的流程約定、踩到的雷、或該固化的習慣，**透過 Trellis Phase 3.3 的 `trellis-update-spec` skill 追加到這裡**（或對應的 `.trellis/spec/<package>/` 文件）。這是 Trellis 內建的知識沉澱機制 —— 每個 task 收尾都必經這一步，所以注意事項會持續長進 spec，不會流失。

### 已累積的注意事項

- **2026-06-02** — 後端首次有測試框架：`functions/` 用 jest + ts-jest，測試放
  `functions/src/__tests__/`，跑 `npm --prefix functions test`。詳見
  [`backend/testing-guidelines.md`](../backend/testing-guidelines.md)。
- **2026-06-02** — 課程約束：Final Demo 僅能用 Flutter + Firebase，禁止自架外部伺服器。
  Firebase **Cloud Functions 允許**（上課教過）；不可在 Firebase 之外另起自管 server。

- **2026-06-05** — Windows PowerShell 5 的 `Set-Content`/`Out-File` 預設**不是 UTF-8**(legacy code page),對含 CJK/符號的原始碼檔做行級編輯會整檔亂碼。改檔一律用 Edit/Write 工具;真要用 PowerShell 寫檔必須帶 `-Encoding utf8`。(06-05 task:`daily_view_page.dart` 被 mangle 後整檔重寫。)
- **2026-06-05** — 「webhook 只收 default branch」的決策已撤銷:改收所有分支(`branch` 欄位、per-commit `create()` first-seen-wins 防止 merge re-push 蓋掉 enrichment)。診斷入口:Functions log 出現 `Skipping push to non-default branch` 即舊版仍在線上。
