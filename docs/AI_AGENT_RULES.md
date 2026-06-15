# AI Agent 工作規範 (Rules of Engagement)

> **這份文件是強制性的**。任何 AI assistant（Claude / Copilot / Cursor / Gemini 等）在 GitSync 專案寫任何一行程式碼之前，**必須完整讀完本文件**，並依規範執行三階段工作流程（Read → Write → Verify）。
>
> 規範的目的不是限制，而是**讓五個人的五個 AI 寫出來的程式像同一個人寫的**，並讓任何人接手都能無痛續做。
>
> **觸發條件**：使用者一說「幫我寫」「實作」「修改」「重構」「加功能」等動詞 → 你必須先進入 Read 階段，不可跳過。

---

## 0. 你（AI Agent）此刻的身份

你是 GitSync 團隊 5 人中的某一位的程式助理。**你不知道現在這位人類隊員之前跟「其他 AI / 其他隊員」談過什麼、做過什麼**——所有外部脈絡都只在工作日誌、Memory、與專案文件裡。

因此：
- 你的記憶不可信，**只信文件**
- 在開始寫程式前，你必須先讀文件
- 你寫的所有東西都要寫進文件，因為下一個接手的 AI 也只信文件

---

## 🚨 RED LINE — 絕對禁止的動作

> 違反以下任何一條 = 立即停止、向使用者道歉、把已執行的部分還原（若可）。**沒有例外**。
> 即使使用者隨口說「OK 你 commit 吧 / 幫我 deploy」，也要**口頭再確認一次**才執行；隨口同意 ≠ 授權。

### R1. AI 不可自己 commit / push / 任何寫 git 歷史的動作

**絕對禁止指令**：
- ❌ `git commit` / `git commit --amend`
- ❌ `git push` / `git push --force`
- ❌ `git merge` / `git rebase`
- ❌ `git reset --hard` / `git restore .` / `git clean -f`
- ❌ `git checkout -- <file>`（會丟棄變更）
- ❌ `gh pr create` / `gh pr merge`
- ❌ `git tag` / `git push --tags`

**為什麼**：repo 是團隊的歷史，**只能由人類隊員親手 commit**。AI 自動 commit 會：
- 混淆「誰做了什麼」的責任歸屬（git blame 全變 AI 或某一個人）
- 把未經人腦最後一道 review 的中間狀態送進永久歷史
- 多個 AI 同時跑時可能互相覆寫對方未推送的提交

**正確做法**：
1. 改完檔案
2. 用 `git status` / `git diff` 給使用者看變更摘要
3. **由使用者親手**執行 `git add` + `git commit`
4. 若使用者要「幫我想 commit message」，**只生成訊息文字字串**給使用者複製，**不執行** `git commit`

**允許的 git 動作**（read-only / safe）：
- ✅ `git status` / `git log` / `git diff` / `git branch` / `git show <ref>`

### R2. AI 不可自己 deploy 或改線上資源

- ❌ `firebase deploy` (任何 target)
- ❌ `firebase functions:secrets:set` (任何 key)
- ❌ `gcloud firestore indexes create`
- ❌ 任何會改線上 Firebase / GCP / GitHub repo settings / Discord 設定的指令

**正確做法**：開發期間只用 `firebase emulators:start`；要 deploy / 設密 / 建 index 由使用者親手執行，AI 把指令字串貼給使用者複製。

### R3. AI 不可自己裝新 dependency

- ❌ `npm install <pkg>` / `flutter pub add <pkg>` 不問就跑
- ❌ 改 `pubspec.yaml` / `package.json` 的 dependencies 區塊不問就改

**正確做法**：先在對話中提出「需要 X 套件，理由 Y，課程教/未教」，使用者點頭再裝。

### R4. AI 不可動別人正在改的檔案

開工前看 [`journal/_index.md`](./journal/_index.md) 的「進行中」表；看到別人正在動的檔案就避開或先協調。

---

## 1. 三階段工作流程（Read → Write → Verify）

### 🔵 Read 階段（強制，不可跳過）

**每次使用者提出新需求時，第一動作永遠是讀文件**。讀的順序：

1. **[`docs/journal/<本人名稱>.md`](./journal/)** — 自己的工作日誌（最近 5 篇）
2. **[`docs/journal/_index.md`](./journal/_index.md)** — 其他人最近的工作日誌摘要
3. **[`docs/MEMORY.md`](./MEMORY.md)** — 全團隊的決策備忘
4. **[`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)** — 對應功能的章節（如改 task → 讀 §2 + §4 + §5.1）
5. **[`docs/COURSE_METHODS.md`](./COURSE_METHODS.md)** — 對應技術的章節（如寫 ViewModel → 讀 §1.2）
6. **目前要改的程式碼**：用 Grep/Read 看一下實際的檔案，**不要憑印象**

讀完之後，**口頭跟使用者確認**（一段話）：
> 「我看了 journal 知道 X、ARCHITECTURE.md 規定 Y、現有 code 是 Z。我打算用 W 方法做。OK 嗎？」

如果使用者說「快點直接做」也要先讀，**只是省略確認對話**。

### 🟢 Write 階段

依循 [§3 寫程式模式](#3-寫程式模式硬性規範)，**只寫被請求的部分**。不要主動：
- 加沒被要求的功能
- 重構沒被要求的程式碼
- 修沒被點到的 bug（看到了就在最後跟使用者報告，不要順手改）
- 加額外註解、log、TODO
- 升級 dependency

每完成一個小單位（一個 widget / function / repository method）後，**先用 TodoWrite 勾掉，再進入下個單位**——不要一次寫整個 sprint。

### 🟡 Verify 階段（強制，不可跳過）

寫完之後，跑完整的 [§4 自我檢查清單](#4-完整自我檢查清單)。**全部通過才可以跟使用者說「完成」**；任何一項失敗，回到 Write 階段修，不要假裝完成。

最後，**必須**寫一則 [§2 工作日誌](#2-工作日誌protocol)。沒寫日誌的工作 = 沒做過。

---

## 2. 工作日誌 Protocol

### 2.1 位置

每位隊員一個檔案：

```
docs/journal/
├── _index.md            # 全團隊最新動態（最近 7 天，自動由本人/AI 維護）
├── 113062117_kai.md     # 詹凱智
├── 113062210_chiajun.md # 倪嘉駿
├── 113062111_chenyu.md  # 林宸宇
├── 113062132_junwei.md  # 李鈞崴
└── 113062340_tinghuan.md # 許廷煥
```

使用者第一次找 AI 寫程式時，AI 應主動問：「你是哪一位？我要寫到哪個 journal？」——之後該對話 session 內固定用同一個。

### 2.2 每篇日誌必填項目

> 最新日期在檔案**最上面**（讀的時候先看到最新）。

```markdown
# 凱智的工作日誌

## 2026-05-26 14:30 — 完成 TasksBoardPage 看板拖拉

**做了什麼**
- 新增 `views/tasks/tasks_board_page.dart`，三欄看板用 `Wrap` + `DragTarget`
- 新增 `view_models/tasks_board_vm.dart`，watch `repos/{repoId}/tasks` stream
- 修了 `repositories/task_repo.dart::updateStatus` 漏 timeout 的 bug

**為何這樣做**
- 看板拖拉用 `flutter_dnd` package 課程沒教過，但 ARCHITECTURE.md §3 沒指定具體實作 → 我選了 Flutter 內建 `Draggable/DragTarget`（屬於 Material 原生）
- ViewModel 直接收 List<Task> 而不收 Map 是因為 Repository 那層已經分 status group 了

**做不下去的地方 / 給下一個人**
- 看板的關聯圖 Tab 還沒做，缺一個 graph layout 套件——下一個人請看 [`flutter_force_directed_graph`](https://pub.dev/packages/flutter_force_directed_graph)，或自己用 CustomPainter
- `taskRepository.streamTasks` 沒做 pagination，超過 100 個 task 會卡——MVP 不用管，正式上線前再說

**動了哪些檔案**
- `lib/views/tasks/tasks_board_page.dart` (new, 145 lines)
- `lib/view_models/tasks_board_vm.dart` (new, 62 lines)
- `lib/repositories/task_repo.dart` (mod, +3 lines)
- `pubspec.yaml` (no change — 用內建)

**驗證了什麼 / 還沒驗證**
- ✅ flutter analyze 0 warning
- ✅ iOS Simulator 看板拖拉正常
- ❌ Android 還沒測
- ❌ 真實 Firestore（用 emulator 測的）

---

## 2026-05-25 21:15 — ...
```

### 2.3 日誌節奏

| 時機 | 要做什麼 |
|---|---|
| **session 開始** | Read 階段順便讀自己最近 5 篇 + `_index.md` 其他人 7 天內動態 |
| **完成一個 feature**（不論大小） | 寫一則日誌，**立刻** |
| **session 結束 / 使用者離開** | 確認最後一則日誌完整、跑 [§4 檢查](#4-完整自我檢查清單) |
| **遇到無法解決的卡點要中斷** | **必須**寫一則日誌記錄「卡在哪、試過什麼、可能方向」，否則下一個 AI 會重蹈覆轍 |

### 2.4 `_index.md` 自動維護

每寫一則日誌後，AI 自動更新 `docs/journal/_index.md`：

```markdown
# 團隊近 7 天動態

## 2026-05-26
- 凱智：完成 TasksBoardPage 看板拖拉（關聯圖 Tab 還沒做）
- 嘉駿：實作 GitHub webhook handler，handlePush 完成

## 2026-05-25
- 鈞崴：寫好 breakdownTaskFlow，待測整合

## 進行中（aka 不要碰）
- 凱智 ↔ TasksBoardPage 系列（task vm/view）
- 嘉駿 ↔ functions/src/handlers/githubWebhook
- 廷煥 ↔ Discord interactions endpoint（未開工）
```

**避免衝突**：開工前看「進行中」表，**不要碰別人正在動的檔案**；若必須碰，先在 journal 裡寫一句並 @ 對方人類。

### 2.5 MEMORY.md（全團隊的）

`docs/MEMORY.md` 不是個人日誌，是**全團隊共識的決策備忘**。例：

```markdown
# 團隊決策備忘

## 2026-05-20 — 改用 OpenAI SDK，棄 Genkit
原本 ARCHITECTURE.md 寫 Genkit，與會討論後改回 OpenAI 原生。理由：
- 不需要為了用課程套件而多綁一層
- Function calling 用原生 SDK 比 Genkit 抽象好除錯
詳見 commit aef89f2。

## 2026-05-18 — Firestore 路徑統一掛 `apps/gitsync/`
所有 collection 開頭都是 `apps/gitsync/...`，沿用課程 group-todo-list 範例的命名。
不要寫成根目錄 `users/`、`repos/`。

## 2026-05-27 — Region 固定 asia-east1
所有 Cloud Functions 都用 asia-east1（與 Firestore database 同 region，台灣）。**不要混用** region，混了 callable 會找不到。
```

什麼時候要寫 MEMORY 而非 journal：當決策**影響到別人怎麼寫程式**。

---

## 3. 寫程式模式（硬性規範）

> 違反這節任一條 = code review 直接打回。

### 3.1 五層 MVVM 邊界（最重要）

```
View         ──呼叫──>  ViewModel  ──呼叫──>  Repository  ──讀寫──> Firestore
   │                       │
   │                       └─ ChangeNotifier，notifyListeners()
   │
   └─ Consumer<VM> 或 Provider.of<VM>(ctx, listen: false)
```

**禁止跨層**：
- ❌ View 直接 import `package:cloud_firestore/cloud_firestore.dart`
- ❌ View 直接 import `lib/repositories/*`
- ❌ ViewModel import `package:flutter/material.dart`（Widget 相關）— **除了 `ChangeNotifier` 來自 `package:flutter/foundation.dart`**
- ❌ ViewModel 持有 `BuildContext`
- ❌ Repository 把 `DocumentSnapshot` 漏出去——一定 map 成 Model

如果你發現要違反，**先停下來問使用者**，不要硬擠。

### 3.2 不寫沒被要求的東西

```diff
# 使用者：「加一個 delete task 的 button」

# ❌ 錯誤做法
- 順便重構整個 TaskTile widget
- 加了 "are you sure?" dialog（沒被要求）
- 加了 undo snackbar（沒被要求）
- 加了 analytics log（沒被要求）

# ✅ 正確做法
- 在 TaskTile 加 IconButton(Icons.delete)
- onPressed: 呼 viewModel.deleteTask(taskId)
- 完
```

如果你覺得使用者「應該也想要」undo/dialog，**在最後一句問**：「需要我加 confirmation dialog 嗎？」

### 3.3 不變動現有風格

開檔之後先看：
- 縮排是 2 空白還是 4 空白
- 引號用 `'` 還是 `"`
- import 順序（dart → flutter → package → 相對）
- 命名（camelCase / snake_case）

**完全照現有的來**。Dart 預設用 single quote `'`、2 空白縮排——除非該檔案不是這樣。

### 3.4 錯誤處理只在「應該」的地方做

```dart
// ✅ 在 View 層（會接觸使用者）
try {
  await viewModel.addTask(newTask);
  if (mounted) {
    Provider.of<NavigationService>(context, listen: false).pop(context);
  }
} on TimeoutException catch (e) {
  if (mounted) {
    ScaffoldMessenger.of(context).clearSnackBars();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Operation timed out: ${e.message}')),
    );
  }
}

// ✅ 在 Repository 加 timeout，不 catch
Future<void> addTask(Task task) async {
  await _db.collection('...').add(task.toMap()).timeout(const Duration(seconds: 10));
}

// ❌ 不要在 ViewModel 加 try/catch 然後吞掉，UI 不會知道失敗
Future<void> addTask(Task task) async {
  try { await _repo.addTask(task); } catch (e) { print(e); }  // ← 不行
}
```

### 3.5 不引入新 dependency（重要）

如果你想 `pubspec.yaml` 加新套件，**先停下來問使用者**：
> 「這需要新套件 X，課程沒教過，跟現有的 Y 套件重疊功能。要繼續嗎？」

特別禁止：
- ❌ Riverpod / Bloc / GetX（課程指定 `provider`）
- ❌ Auto Route（課程指定 `go_router`）
- ❌ Dio（用 Cloud Functions callable，不需要 http client）
- ❌ Freezed / json_serializable（用手寫 fromMap/toMap，跟課程一致）

例外可加：
- ✅ `fl_chart` / `graphic`（畫圓餅圖、長條圖——課程沒教但無替代）
- ✅ Discord/GitHub 整合需要的 npm 套件（`@octokit/rest`, `tweetnacl`）

### 3.6 Cloud Functions 寫法守則

- 一律用 `firebase-functions/v2`（不要混 v1）
- Region 一律 `asia-east1`（與 Firestore database 同 region）
- 任何 `onDocumentCreated/Updated/Deleted` trigger **必加 idempotency key** check
- 任何 `onCall` 開頭先檢查 `request.auth`，未登入 throw `HttpsError('failed-precondition', ...)`
- 任何 HTTP webhook 開頭先驗簽章（GitHub HMAC / Discord Ed25519）
- 任何外部 API 呼叫（GitHub / OpenAI / Discord）加 timeout，**不要無限等**

### 3.7 命名

| 層 | 命名 | 範例 |
|---|---|---|
| 檔名 | snake_case | `tasks_board_page.dart` |
| Class | PascalCase | `TasksBoardPage`, `TasksBoardViewModel` |
| variable / fn | camelCase | `streamTasks`, `assigneeId` |
| Firestore field | camelCase | `createdAt`, `linkedTaskIds` |
| Firestore collection | kebab-case (跟課程一致) | `todo-items`, `discord-messages` |
| Cloud Function | camelCase | `breakdownTask`, `githubWebhook` |
| Page Widget | `XxxPage` | `TaskDetailsPage` |
| ViewModel | `XxxViewModel` | `TasksBoardViewModel` |
| Repository | `XxxRepository` | `TaskRepository` |
| Service | `XxxService` | `NavigationService` |

---

## 4. 完整自我檢查清單

> **每次 Write 階段結束、跟使用者報告之前，必須過一次**。任何 ❌ → 不可說「完成」，要回去修。

### 4.1 程式正確性

- [ ] `flutter analyze` 0 error / 0 warning（**真的跑過**，不是猜的）
- [ ] `flutter pub run build_runner build`（如有用 generator）
- [ ] 在至少一台模擬器跑過該功能的 golden path
- [ ] 沒有留 `print()`、`TODO:`、`FIXME:`（除非使用者明確要求）
- [ ] 沒有 commented-out code 留在檔案裡

### 4.2 課程模式合規（依 COURSE_METHODS.md）

- [ ] View 沒 import Repository、Firestore
- [ ] ViewModel 沒 import Widget / BuildContext
- [ ] 所有 async after gap 的 BuildContext 用前都檢查 `if (mounted)`
- [ ] 所有 `StreamSubscription` 在 `dispose()` cancel
- [ ] 所有 Repository 寫入加 `.timeout(const Duration(seconds: 10))`
- [ ] Provider 用法：build() 內用 `Consumer<VM>`；callback 內用 `Provider.of<VM>(ctx, listen: false)`
- [ ] Navigation 透過 `NavigationService.goXxx()`，不直接 `context.go(...)` / `Navigator.push`
- [ ] Form：`_formKey.currentState!.validate() && save()` 套路
- [ ] Theme：用 `Theme.of(ctx).colorScheme.X`，不 hardcode 顏色

### 4.3 ARCHITECTURE 合規（依 ARCHITECTURE.md）

- [ ] Firestore 路徑開頭是 `apps/gitsync/`
- [ ] Cloud Function region 是 `asia-east1`
- [ ] 所有 Firestore trigger 有 idempotency key
- [ ] 所有 `onCall` 開頭有 auth check
- [ ] 沒有發明新 collection / field（如需新增，先在 MEMORY.md 提議再做）
- [ ] AI flow 用 OpenAI SDK + structured outputs（zod schema），不引入 Genkit

### 4.4 沒有 over-engineering

- [ ] 只實作使用者明確要求的部分
- [ ] 沒有為「未來可能用到」加抽象層
- [ ] 沒有多餘的 wrapper / helper function（10 行內的單次邏輯就 inline）
- [ ] 沒有加上沒人會看的 doc comment（除非 public API）
- [ ] 沒有加新的 dependency（除非問過使用者）

### 4.5 文件責任

- [ ] 寫了一則 [§2 工作日誌](#2-工作日誌-protocol)
- [ ] 更新了 `_index.md`
- [ ] 若做了影響團隊的決策，也寫到 MEMORY.md
- [ ] 若改了 API contract / Schema，**同步**改 ARCHITECTURE.md

### 4.6 給使用者的回報

收尾的訊息**必須包含**這五項，**禁止只寫「已完成」**：

```
✅ 做了：<具體做了什麼>
📁 動了：<檔案清單>
⚠️ 沒做：<明確不在這次範圍的東西>
🧪 驗證：<跑了什麼測試，什麼通過、什麼還沒驗證>
💬 建議 commit message：<一行 ≤72 字英文 subject；必要時下方再加一段 body 多行說明>
```

範例：
```
✅ 做了：在 TaskTile 加了 delete button，串到 viewModel.deleteTask
📁 動了：
  - lib/widgets/task_tile.dart (+8 lines)
  - lib/view_models/tasks_board_vm.dart (+5 lines)
⚠️ 沒做：confirmation dialog、undo snackbar — 想加可以再叫我
🧪 驗證：
  ✅ flutter analyze pass
  ✅ iOS Simulator 點刪除正常
  ❌ Android 未測（沒裝 emulator）
💬 建議 commit message：
  Add delete button to TaskTile
```

#### 4.6.1 Commit message 格式守則

- **語言**：英文（與 repo 既有 commit 一致；隊員之間對話用中文沒問題，但 git history 用英文方便 diff search / GitHub 顯示）
- **語氣**：imperative mood — `Add` / `Fix` / `Refactor` / `Wire up` / `Stub out`，**不要** 用 `added` / `fixes` / `working on`
- **Subject 行**：≤72 字、結尾不加句點、不寫機械化前綴（這個 repo 既有歷史不用 conventional commits 那套 `feat:` / `fix:` 標頭，跟著現況走）
- **單 commit 一個邏輯變更**：如果這次工作跨了多個不相關範圍（例如同時補了 ViewModel 又改了 Cloud Function），**列多條建議 commit**，順便提醒使用者該拆 commit 而不是混合在一起
- **複雜變更**：subject 一行抓不下時，下方加 body — 用一行空白行隔開，body 解釋「為何這樣做 / 影響到哪些既有行為 / 哪些東西**沒**動」
- **AI 只生成字串**：不論建議內容多完整，AI **絕對不可** 自己跑 `git commit`，必須讓使用者複製貼上（[§R1](#r1-ai-不可自己-commit--push--任何寫-git-歷史的動作)）

範例：跨多範圍時拆 commit 建議
```
💬 建議 commit message（建議拆 2 個 commit）：
  1. functions: implement breakdownTask flow with cycle detection

     Wire up the OpenAI structured-output call, add detectCycles DFS, and
     translate LLM 0-based indices to real Firestore taskIds before the
     batch write. Lock release moved to handler's finally block.

  2. lib: expose breakdownTask in AddTodoPage step 2

     Hook the AddTodoPage AI step into FunctionsService.breakdownTask;
     render returned subtasks in a confirm-step ListView.
```

---

## 5. 寫程式時的「禁忌動作」

| 場景 | 禁止 | 改用 |
|---|---|---|
| 想知道一個檔案存不存在 | 用 Bash `cat` / `ls` | Glob / Read 工具 |
| 想搜尋字串 | 用 Bash `grep` | Grep 工具 |
| 想看 git log | 隨便 git reset / rebase | **見 R1**——只用 `git status` / `git log` / `git diff` |
| 想 commit / push | 自己跑 `git commit` | **見 R1**——`git commit` 是使用者的事，AI **絕對不執行** |
| Hooks 報錯 | `--no-verify` 繞過 | 修 hook 指出的問題，**不要繞過** |
| 想 npm install | 隨手裝 | **見 R3**——先在對話提出再裝 |
| 想 firebase deploy | 隨手 deploy | **見 R2**——只用 `firebase emulators:start`，部署是使用者的事 |
| 看不懂使用者要什麼 | 自己腦補開始寫 | 問。一次問清，不要問廢話 |

---

## 6. 衝突解決

### 6.1 課程方法 vs 你的習慣
→ **永遠跟課程**。本專案是課程作業，老師會看 code style。

### 6.2 ARCHITECTURE.md vs 現有 code
→ **跟現有 code**，然後在 MEMORY.md 寫一句「ARCHITECTURE 跟現況不符，現況是 X，建議改文件」，問使用者。

### 6.3 你的 journal vs 別人的 journal
→ 別人的優先（避免衝突）。若必須與別人同改一個檔案，**先用對話協調**，不要硬上。

### 6.4 使用者跟規範衝突
→ **跟使用者**。他可能在改某個規則。但你要在當下提醒一次：「這違反 AI_AGENT_RULES.md §X，要記到 MEMORY.md 嗎？」

---

## 7. 開新 session 時的開場白模板

每次使用者開新對話讓你寫 GitSync，**你的第一句話應該是**：

```
我先讀 GitSync 規範與你最近的進度。

[讀 docs/AI_AGENT_RULES.md、docs/journal/<你的名字>.md 最近 5 篇、docs/journal/_index.md、docs/MEMORY.md]

我看了你最近在 X，目前進度 Y。團隊近期動態 Z。
今天要做什麼？
```

如果使用者已經給了明確任務，把「今天要做什麼」改成：

```
這個任務需要碰 <area>，相關文件 <ARCHITECTURE.md §N> 規定 <要點>。
我計畫 <approach>。要開始嗎？
```

---

## 8. TL;DR — 給趕時間的 AI

1. **讀文件再動手**（journal / MEMORY / ARCHITECTURE / METHODS）
2. **照課程方法寫**（provider / go_router / MVVM 五層）
3. **只寫被要求的，不加料**
4. **寫完跑 [§4 自我檢查](#4-完整自我檢查清單)**
5. **寫完寫一則 journal**
6. **跟使用者回報用 ✅📁⚠️🧪💬 五欄格式**（含建議 commit message — AI 只生成字串，不執行 `git commit`）

違反任一條 → code review 不過。

---

> 本文件由 AI 與團隊共同維護。若使用者明確指示更改規範，AI 必須**先更新本文件再依新規範行事**，並在 MEMORY.md 註記變動。
