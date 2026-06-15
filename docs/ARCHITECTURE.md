# GitSync — 整體架構設計 (Architecture Plan)

> **目標**：讓開發者專注於真正重要的事。整合 GitHub + Discord，由 AI Agent 自動拆解任務、分派負載、生成技術交接文件。
>
> **本文件搭配** [`COURSE_METHODS.md`](./COURSE_METHODS.md) **一起看** — Methods 寫「怎麼用課程教的寫法寫 code」，本文件寫「系統由哪些零件組成、各零件的職責、API 與資料 schema」。

---

## 0. 技術選型總結

| 項目 | 選擇 | 理由 |
|---|---|---|
| 前端 | Flutter (iOS + Android) | 課程指定，與 prototype 一致 |
| 後端 Runtime | Firebase Cloud Functions (Node.js 22 + TypeScript) | 課程的 AI Agent / Webhook 教學都在這 |
| 資料庫 | Cloud Firestore | 課程指定，即時同步、與 Functions 整合 |
| Auth | Firebase Auth + GitHub OAuth Provider | 一次拿到 user + GitHub access token |
| AI SDK | OpenAI 官方 Node.js SDK (`openai` npm) | 不勉強套 Genkit，直接用原生 function calling + structured outputs |
| AI Model | OpenAI GPT-4o（推理）+ GPT-4o-mini（輕量）+ text-embedding-3-small（向量） | 已選定 |
| Vector Search | Firestore 原生 `findNearest`（COSINE） | 與 Firestore 同源，免外掛 |
| State Mgmt (Flutter) | `provider` 6.x | 課程指定 |
| Router (Flutter) | `go_router` 14.x | 課程指定 |
| Push | Firebase Cloud Messaging (FCM) | 課程教法 |
| Discord Bot | Cloud Functions HTTPS + Discord Interactions API | 無需常駐 server，符合 Firebase 模型 |
| GitHub 整合 | Webhook → Cloud Functions HTTPS + Octokit REST | 標準作法 |
| 主題色 | Light: `#1565C0`(深藍) / Dark: `#FAB28E`(橘) | Prototype 已決定 |

---

## 1. 系統架構圖

```
┌────────────────────────────────────────────────────────────────────┐
│                         Flutter App (Mobile)                        │
│  ┌─────────┐  ┌────────────┐  ┌──────────┐  ┌─────────┐  ┌──────┐ │
│  │ SignIn  │  │ RepoList   │  │ TaskBoard│  │ Daily   │  │Stats │ │
│  └─────────┘  └────────────┘  └──────────┘  └─────────┘  └──────┘ │
│       │                            │                                │
│       ▼                            ▼                                │
│  AuthService              ViewModels (Provider/ChangeNotifier)      │
│       │                            │                                │
│       └────────────┬───────────────┘                                │
│                    ▼                                                │
│              Repositories (Stream<List<T>> from Firestore)          │
└────────────────────┬───────────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
┌──────────────┐      ┌──────────────────────────────────────────────┐
│ Firebase Auth│      │            Cloud Firestore                    │
│  ─ GitHub    │      │  apps/gitsync/{users,repos,tasks,commits,...}│
│    OAuth     │      └──────────────────────────────────────────────┘
└──────────────┘             ▲           ▲           ▲
                             │           │           │
                  ┌──────────┴───┐  ┌────┴────┐  ┌──┴──────────────┐
                  │ HTTP Triggers│  │Firestore│  │ Callable        │
                  │ (Webhooks)   │  │Triggers │  │ (Flutter→Func)  │
                  └──────────────┘  └─────────┘  └─────────────────┘
                         ▲              │                ▲
                         │              ▼                │
                  ┌──────┴───┐   ┌─────────────┐   ┌─────┴─────┐
                  │  GitHub  │   │   AI Flow   │   │  Flutter  │
                  │  Webhook │   │ (OpenAI SDK)│◄──┤  App      │
                  │  Events  │   │             │   └───────────┘
                  └──────────┘   └─────────────┘
                         ▲              │
                  ┌──────┴───┐          ▼
                  │ Discord  │   ┌─────────────┐
                  │ Bot      │   │  OpenAI API │
                  │(Webhooks │   │ (GPT-4o +   │
                  │ + REST)  │   │  embedding) │
                  └──────────┘   └─────────────┘
                         ▲
                         │
                  ┌──────┴───┐
                  │ Discord  │
                  │ Channel  │
                  └──────────┘
```

---

## 2. Firestore Schema

> 所有 collection 都掛在 `apps/gitsync/` 之下（沿襲課程作法）。

### 2.1 collections

```
apps/gitsync/
├── users/{userId}                              # Firebase Auth UID
│   ├── name: string
│   ├── email: string
│   ├── avatarUrl: string
│   ├── githubLogin: string                     # GitHub username (e.g. "john-developer")
│   ├── githubAccessToken: string (encrypted)   # 用來呼叫 GitHub API
│   ├── discordUserId: string?                  # ★ Discord 18-digit snowflake (e.g. "123456789012345678")
│   │                                           #   讓 RAG 把 discordMessages.authorId 對應回此 user
│   ├── fcmToken: string
│   ├── expertiseTags: string[]                 # ["frontend", "ml"] 自動學習
│   ├── createdAt: Timestamp
│   └── repos/{repoId}                          # subcollection: 此 user 加入的 repo
│       └── role: "owner" | "member"
│
├── repos/{repoId}                              # repoId = `${owner}_${name}` 或 GitHub repo ID
│   ├── name: string                            # "team17/gitsync"
│   ├── url: string
│   ├── githubRepoId: number
│   ├── defaultBranch: string
│   ├── webhookId: number                       # GitHub webhook ID (供刪除用)
│   ├── webhookSecret: string                   # HMAC 驗證
│   ├── discordWebhookUrl: string?              # 用戶設定的 Discord channel webhook (outbound 通知)
│   ├── discordChannelIds: string[]             # 監聽的 Discord channel IDs (由 /gitsync-listen → setRepoChannel arrayUnion)
│   ├── discordGuildId: string?                 # 綁定的 Discord guild (多 guild 時用；setRepoChannel 寫入)
│   ├── memberIds: string[]                     # 鏡像 subcollection 方便 array-contains query
│   ├── isBreakingDown: boolean                 # 分散式鎖：AI 拆解任務進行中
│   ├── breakdownStartedAt: Timestamp?          # 配 isBreakingDown 用；> 5min 視為卡住可強制解鎖
│   ├── createdAt: Timestamp
│   ├── createdBy: userId
│   │
│   ├── members/{userId}                        # subcollection
│   │   ├── role: "owner" | "admin" | "member"
│   │   ├── activeIssueCount: number            # 即時負載 (供任務分派 AI)
│   │   ├── completedTaskCount: number
│   │   └── lastActiveAt: Timestamp
│   │
│   ├── tasks/{taskId}                          # 看板上的卡片
│   │   ├── title: string
│   │   ├── description: string
│   │   ├── status: "todo" | "in_progress" | "done"
│   │   ├── assigneeId: string?
│   │   ├── dependsOn: string[]                 # taskId 陣列
│   │   ├── githubIssueNumber: number?          # 對應的 GitHub issue
│   │   ├── linkedPRNumbers: number[]
│   │   ├── acceptanceCriteria: string[]
│   │   ├── handoffDoc: string?                 # AI 生成的交接文件 markdown
│   │   ├── handoffGeneratedAt: Timestamp?
│   │   ├── source: "manual" | "ai_breakdown" | "github_issue"
│   │   ├── parentTaskId: string?               # 若由 AI 拆解出來
│   │   ├── createdAt: Timestamp
│   │   ├── createdBy: userId
│   │   └── updatedAt: Timestamp
│   │
│   ├── commits/{commitSha}                     # 由 webhook 寫入
│   │   ├── repoId: string                      # ← 冗餘儲存，供 findNearest 預過濾用
│   │   ├── message: string
│   │   ├── messageEmbedding: Vector            # FieldValue.vector(), 1536 dim (text-embedding-3-small)
│   │   ├── author: { login, name, email }
│   │   ├── url: string
│   │   ├── filesChanged: string[]
│   │   ├── additions: number
│   │   ├── deletions: number
│   │   ├── linkedTaskIds: string[]             # 從 commit message 解析 (e.g. "fix #12")
│   │   ├── aiSummary: string?                  # AI 生成的人話摘要
│   │   ├── branch: string?                     # 06-05 D1: 首次出現的 push ref（refs/heads/ 去掉）；legacy doc 無此欄
│   │   └── committedAt: Timestamp
│   │
│   ├── pullRequests/{prNumber}
│   │   ├── repoId: string                      # ← 冗餘儲存
│   │   ├── title: string
│   │   ├── state: "open" | "merged" | "closed"
│   │   ├── author: string
│   │   ├── headBranch: string
│   │   ├── baseBranch: string
│   │   ├── linkedTaskIds: string[]
│   │   ├── commitShas: string[]
│   │   ├── diffStat: { additions, deletions, changedFiles }
│   │   ├── mergedAt: Timestamp?
│   │   └── url: string
│   │
│   ├── discordMessages/{messageId}             # Discord 抓回來的訊息
│   │   ├── repoId: string                      # ← 冗餘儲存，供 findNearest 預過濾用
│   │   ├── channelId: string
│   │   ├── authorId: string                    # Discord user
│   │   ├── content: string
│   │   ├── mentionedUserIds: string[]
│   │   ├── linkedTaskIds: string[]             # AI 推斷
│   │   ├── timestamp: Timestamp
│   │   └── embedding: Vector?                  # FieldValue.vector(), 1536 dim — RAG 用
│   │
│   ├── fetchRequests/{requestId}               # on-demand Discord 回補請求佇列 (§7.2)
│   │   ├── repoId: string
│   │   ├── date: string                        # YYYY-MM-DD (要回補哪一天)
│   │   ├── status: "pending" | "claimed" | "ingested" | "done" | "digest_failed"
│   │   ├── requestedBy: userId
│   │   ├── createdAt: Timestamp
│   │   ├── claimedAt: Timestamp?
│   │   ├── ingestedCount: number?
│   │   ├── ingestedAt: Timestamp?
│   │   └── completedAt: Timestamp?
│   │
│   ├── discordDigests/{YYYY-MM-DD}             # AI 整理的每日 Discord digest (§7.4)
│   │   ├── date: string
│   │   ├── markdown: string                    # AI 生成 (gpt-4o-mini)
│   │   ├── messageCount: number
│   │   └── generatedAt: Timestamp
│   │
│   ├── discordChannels/{channelId}             # per-channel 增量回補設定 (§7.2)
│   │   ├── guildId: string
│   │   ├── startDate: string?                  # YYYY-MM-DD，app date picker 設
│   │   ├── lastMessageId: string?              # 增量 watermark（最後抓到的 snowflake）
│   │   ├── startDateSetAt: Timestamp?
│   │   └── lastFetchedAt: Timestamp?
│   │
│   └── dailyReports/{YYYY-MM-DD}
│       ├── repoId: string
│       ├── summary: string                     # AI 生成
│       ├── completedTasks: string[]
│       ├── memberContributions: { [userId]: { tasksDone, commits, githubLogin, displayName } }
│       │                                       # 名字由後端產生報告時從 roster 解析寫入；
│       │                                       # 舊報告缺名字欄位 → 前端 fallback 顯示 key
│       └── generatedAt: Timestamp
│
└── idempotencyKeys/{eventId}                   # Functions trigger 防重
    └── processedAt: Timestamp
```

### 2.2 Firestore Security Rules

**設計重點**：
1. 不使用 `match /{document=**}` 萬用字元 + `get()`，每次存取 subcollection 會多一次 RTT，浪費 Read Quota
2. 對「應用程式不該直接寫」的 collection（commits / pullRequests / discordMessages / dailyReports）一律 `allow write: if false`，**只允許 Cloud Functions（admin SDK 繞過 rules）寫入**——這也讓 webhook 來源更安全
3. 對「應用程式會寫」的 collection（tasks）才接受 `get()` 確認 membership

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // 1. 使用者文件：只有本人可讀寫
    match /apps/gitsync/users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;

      // 子集合 repos/ 鏡像 — 只有本人讀寫
      match /repos/{repoId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }

    // 2. Repo 根文件：只有 member 可讀；create 開放給已登入；update 限 member
    match /apps/gitsync/repos/{repoId} {
      allow read, update: if request.auth != null
                          && request.auth.uid in resource.data.memberIds;
      allow create: if request.auth != null;
      allow delete: if false; // 只能透過 Cloud Function removeRepo

      // 2a. members — 只能 Cloud Functions 寫，member 可讀
      match /members/{memberId} {
        allow read: if request.auth != null
                    && request.auth.uid in get(/databases/$(database)/documents/apps/gitsync/repos/$(repoId)).data.memberIds;
        allow write: if false;
      }

      // 2b. tasks — member 可讀寫（這是唯一需要 get() 驗 membership 的 subcollection）
      match /tasks/{taskId} {
        allow read, write: if request.auth != null
                           && request.auth.uid in get(/databases/$(database)/documents/apps/gitsync/repos/$(repoId)).data.memberIds;
      }

      // 2c. commits / pullRequests / discordMessages / dailyReports — 只允許 Cloud Functions 寫
      match /commits/{commitSha} {
        allow read: if request.auth != null
                    && request.auth.uid in get(/databases/$(database)/documents/apps/gitsync/repos/$(repoId)).data.memberIds;
        allow write: if false;
      }
      match /pullRequests/{prNumber} {
        allow read: if request.auth != null
                    && request.auth.uid in get(/databases/$(database)/documents/apps/gitsync/repos/$(repoId)).data.memberIds;
        allow write: if false;
      }
      match /discordMessages/{messageId} {
        allow read: if request.auth != null
                    && request.auth.uid in get(/databases/$(database)/documents/apps/gitsync/repos/$(repoId)).data.memberIds;
        allow write: if false;
      }
      match /dailyReports/{date} {
        allow read: if request.auth != null
                    && request.auth.uid in get(/databases/$(database)/documents/apps/gitsync/repos/$(repoId)).data.memberIds;
        allow write: if false;
      }
    }

    // 3. Idempotency keys — 只 Cloud Functions 用
    match /apps/gitsync/idempotencyKeys/{eventId} {
      allow read, write: if false;
    }
  }
}
```

> **權衡**：`tasks` 與其他 read-only subcollection 仍各做一次 `get()` 驗 membership，但**單次 `get()` 在同一個 request 內會被 Firestore 自動 cache**，所以一次 `streamTasks()` 全 page 只算 1 次 get。這比萬用字元 + 每筆 `get()` 便宜許多。

---

## 3. 前端 (Flutter) — 頁面對應

依 prototype `references/GitSync/src/app/routes.tsx` 設計 Flutter 路由：

```
/                       → SignInPage
/repos                  → RepoListPage
/repos/add              → AddRepoPage
/repos/:repoId          → ShellRoute (RepoLayout，含 BottomNav)
  ├── /tasks            → TasksBoardPage (看板 / 關聯圖兩個 Tab)
  │   ├── /add          → AddTodoPage (3 步驟：輸入 → AI 生成 → 確認)
  │   └── /:taskId      → TaskDetailsPage (含 handoff)
  ├── /daily            → DailyViewPage (日報 / commit / DC 群三 Tab)
  ├── /stats            → StatsViewPage (貢獻度 / 進度表)
  └── /settings         → SettingsPage
/notify                 → NotifyScreen (push 通知開啟跳轉)
```

### 主要 ViewModels

| ViewModel | 訂閱來源 | 提供給 |
|---|---|---|
| `AuthViewModel` | `FirebaseAuth.idTokenChanges()` | 全域 |
| `RepoListViewModel` | `users/{uid}/repos` stream | RepoListPage |
| `TasksBoardViewModel` | `repos/{repoId}/tasks` stream | TasksBoardPage, TaskDetailsPage |
| `MembersViewModel` | `repos/{repoId}/members` stream | TaskAssign dialog, StatsView |
| `DailyReportViewModel` | `repos/{repoId}/dailyReports` + 今日 commits stream | DailyViewPage |
| `CommitsViewModel` | `repos/{repoId}/commits` stream (limit 50) | DailyViewPage |
| `DiscordMessagesViewModel` | `repos/{repoId}/discordMessages` stream | DailyViewPage |
| `StatsViewModel` | derived from TasksBoardViewModel + CommitsViewModel | StatsViewPage |
| `ThemeModeNotifier` | local SharedPreferences | 全域 |

---

## 4. Cloud Functions — 後端 API

### 4.1 Callable Functions（從 Flutter 直接呼叫）

> 一律走 `firebase-functions/v2/https` 的 `onCall`，region = `asia-east1`（與 Firestore database 同 region，台灣）。

| Function | 輸入 | 輸出 | 用途 |
|---|---|---|---|
| `addRepo` | `{ githubUrl: string }` | `{ repoId }` | 解析 URL → 呼叫 GitHub API 驗證 → 註冊 webhook → 寫 Firestore |
| `removeRepo` | `{ repoId }` | `{}` | 刪除 webhook + Firestore docs |
| `breakdownTask` | `{ repoId, goal: string }` | `{ subtasks: [...] }` | AI Flow — 任務拆解（自帶 `isBreakingDown` 鎖）|
| `forceUnlockBreakdown` | `{ repoId }` | `{}` | 強制解 `isBreakingDown` 鎖（卡 > 5min 時前端顯示「重置」按鈕呼叫）|
| `assignTask` | `{ repoId, taskId }` | `{ assigneeId, reason }` | AI Flow — 動態分派 |
| `generateHandoff` | `{ repoId, taskId }` | `{ handoffMarkdown }` | AI Flow — 交接文件 |
| `summarizeDay` | `{ repoId, date }` 或 `{ repoId, startDate, endDate }` | `{ summary, highlights, blockers, commitThemes, memberContributions, ... }` | AI Flow — 時段報告生成（agentic，§5.4；上限 92 天）|
| `dailyBrief` | `{ repoId, date, endDate?, question, history? }` | `{ answer, commits[] }` | AI Flow — Summary tab「問 AI 這段期間」agentic 聊天（§5.4）|
| `explainCommit` | `{ repoId, sha, force? }` | `{ markdown, cached }` | AI Flow — commit tree 地圖點擊的工作總結（§5.4；cache 在 `commits/{sha}.workSummary`）。06-05 D2：doc 不存在時 fallback 到 GitHub API（`githubClient.getCommit`，用 caller 的 token）摘要 branch-graph commit，不寫 cache |
| `getCommitGraph` | `{ repoId, startDate?, endDate? }` | `{ commits[], branches[], cached, truncated }` | Commits 分頁分支圖 — 即時向 GitHub GraphQL 拉 branch 拓撲（parents/avatar/PR 關聯;webhook payload 沒有 parents）,90s Firestore cache（`repos/{repoId}/graphCache/{key}`）,分支上限 20；非快取回應時 best-effort 把抓到的 commit 補寫成 commit docs（與 push webhook 同 shape + first-seen-wins `create()`，補上歷史缺口、觸發 `onCommitCreated`；失敗不影響回應）(06-05 D7) |
| `setDiscordWebhook` | `{ repoId, webhookUrl, channelIds[] }` | `{}` | 設定 Discord outbound webhook + 監聽頻道 |
| `subscribeToTopic` | `{ token, topic }` | `{}` | FCM web push（同課程） |

### 4.2 HTTP Webhook Functions（外部呼叫）

| Function | 來源 | 處理 |
|---|---|---|
| `githubWebhook` | GitHub | 驗證 HMAC → 依 event 類型分派 (`push`/`pull_request`/`issues`) → 寫 Firestore |
| `discordMessageIngest` | 使用者自架的 forwarder bot | 驗共享密鑰 → 寫 `discordMessages/{messageId}`；詳見 §7.2 |

### 4.3 Firestore Triggers（事件驅動）

> **職責切分原則**：HTTP webhook 只做「驗證 + 把外部 raw payload 標準化後寫入 Firestore 文件」；所有「解析業務語意 / 呼叫 OpenAI / 跨文件更新」一律下沉到 Firestore Trigger。這樣才能：
> 1. webhook 在 3 秒內回完外部（GitHub / Discord 不會 retry / 不會 timeout）
> 2. AI 重邏輯都有 idempotency key 保護（trigger 內統一加），不會被外部重送搞壞

| Trigger | 事件 | 動作 |
|---|---|---|
| `onTaskCreated` | tasks/{taskId} create | 若 `source == "manual"`，可選擇呼叫 AI 自動分派；建 GitHub issue |
| `onTaskUpdated` | tasks/{taskId} update | 若 `status` 變 "done"：發 FCM 給下游 (`dependsOn` 反向查) + 推 Discord webhook + 觸發 `generateHandoff` |
| `onCommitCreated` | commits/{sha} create | 1. idempotency check → 2. `shouldSkipEmbedding(message)` 過濾 → 3. 解析 `#N`/`fixes #N` 找對應 task 寫 `linkedTaskIds` → 4. 算 `messageEmbedding` → 5. 生成 `aiSummary` |
| `onPRMerged` | pullRequests/{n} update where state→"merged" | idempotency check → transaction 內把 `linkedTaskIds` 對應 tasks 標 done + 加計 member counter |
| `onDiscordMessageCreated` | discordMessages/{id} create | idempotency check → 過濾規則複查 → 算 embedding → AI 推斷 `linkedTaskIds` 並補回去 |
| `scheduledDailyReport` | Pub/Sub schedule 18:00 daily | 扇出（見 §5.4）→ 每 repo 一個 `dailyReportWorker` instance |
| `scheduledUnstickBreakdown` | Pub/Sub schedule 每 10 分鐘 | 掃 `repos` where `isBreakingDown == true AND breakdownStartedAt < now - 5min` → 強制解鎖（兜底 §5.1）|

**所有 trigger 都要做 idempotency key check**（見 [COURSE_METHODS § 6.2](./COURSE_METHODS.md#62-必學idempotency-key-模式)）。

### 4.4 併發 (Race Condition) 防禦守則

Webhook / trigger 會併發執行（GitHub 一次 push 10 個 commits → 10 個 `onCommitCreated` 同時跑）。違反以下任一規則 → 計數會錯、狀態會被互蓋。實作細節照 [`COURSE_METHODS.md §6.2`](./COURSE_METHODS.md#62-必學idempotency-key-模式)。

**規則 A — 數值欄位禁止「先讀後寫」**

任何 counter（`members.activeIssueCount`、`members.completedTaskCount`、未來任何累加欄位）都必須用 Firestore 的 atomic 操作（`FieldValue.increment(±1)`），不可以先 `get` 拿舊值再算 `+1` 寫回。原因：10 個 trigger 併發時，每個讀到的舊值都相同，最後互蓋變成只 +1 而非 +10。

**規則 B — 跨欄位 / 跨文件狀態變更必用 transaction**

例如 `onPRMerged` 要同時把 task 標 done 並加計 member counter，必須包在 `runTransaction` 裡。transaction 內先 read 確認 task 還沒被標 done（idempotent guard），再做 update。否則兩個 trigger 同時觸發會雙重加計。

**規則 C（最重要）— Firestore Trigger 是 at-least-once 交付，必須做 idempotency**

Firebase 不保證 trigger 正好一次。底層網路抖動、retry 機制都會讓同一個 event 觸發多次。`FieldValue.increment(1)` 是原子操作能避免併發互蓋，但**擋不住「同一事件被送兩次 → 加兩次」**。

標準寫法：每個 trigger 開頭跑一個 transaction：(a) get `apps/gitsync/idempotencyKeys/{event.id}` → (b) 若已存在 return → (c) 否則 set 已處理戳記 → 跳出 transaction 後再跑業務邏輯。範例見 [`COURSE_METHODS.md §6.2`](./COURSE_METHODS.md#62-必學idempotency-key-模式)。

**規則 D — idempotency mark 與慢速副作用不可放同一 transaction**

一旦 idempotency transaction commit，event 就被標記成「已處理」；若隨後的 OpenAI / GitHub API 呼叫失敗，整個 event 不會 retry — 資料就缺了。

正確順序是：先 transaction 標記 idempotency key、退出 transaction 後才呼叫 OpenAI embed / summary、最後再把結果寫回原文件。

若擔心外部呼叫失敗導致欄位永遠為 null：兩種選擇——
1. 嚴格模式：標記前先把 event 留在 `pendingEvents/{eventId}` queue，做完才從 queue 刪
2. 寬鬆模式（建議 MVP）：接受偶爾的 `aiSummary` / `embedding` 為 null（這只是錦上添花，不影響正確性），UI 上提供「重新生成」按鈕讓使用者手動補。

---

## 5. AI Agent 設計（三個核心 Flow）

> 全部用 OpenAI 官方 SDK：**structured outputs**（`response_format` + zod schema）保證 JSON 正確、**function calling**（tool use）做 agentic 自主檢索。詳細寫法見 [`COURSE_METHODS.md §8`](./COURSE_METHODS.md#8-ai-agent--openai-sdk-直接使用後端)。
>
> 每個 flow 是一個 async function 在 `functions/src/flows/` 下，由 `handlers/` 的 `onCall` 包成 Firebase Callable。

### 5.1 Flow 1 — `breakdownTaskFlow`（任務拆解）

對應 prototype 核心功能 01。

**Input**: `{ repoId: string, goal: string }`
**Output**: `{ subtasks: [{ title, description, dependsOn: number[], estimatedHours }] }`

**dependsOn 型別約定（解決 LLM 生不出 taskId 的問題）**：

| 階段 | dependsOn 型別 | 內容 |
|---|---|---|
| AI output (Zod schema) | `number[]` | **0-based 陣列索引**（指向同一輪輸出的其他 subtask 位置）|
| Flutter / Firestore | `string[]` | **真實的 taskId**（Firestore doc id）|

中間的「索引 → taskId」翻譯由 Step 4-6 後端處理，**Flutter 端永遠只看到 taskId**。

**Steps**:

```
Step 1 — fetchProjectContext()                 [純 TS]
  ├─ Read repos/{repoId} + existing tasks
  ├─ Read recent 20 commits via GitHub API
  ├─ Read repo README (optional)
  └─ output: projectContextString

Step 2 — openai.chat.completions.parse(...)    [structured output via zod]
  ├─ system: breakdownTaskSystem
  ├─ user: projectContext + goal
  ├─ response_format: zodResponseFormat(BreakdownOutputSchema)
  └─ output: [{ title, description, dependsOn: number[], estimatedHours }, ...]
                                       ↑ 0-based 索引

Step 3 — detectCycles(subtasks)                [純 TS DFS on index graph]
  └─ if cycle found ─→ Step 3b

Step 3b — re-prompt with cycle info            [agentic 自我修正]
  ├─ Append previous response + error message
  └─ output: fixed subtasks

Step 4 — pre-generate taskIds                  [純 TS]
  ├─ const ids = subtasks.map(_ => tasksCollection.doc().id)   // Firestore auto-id
  └─ output: ids: string[]

Step 5 — translate index → taskId              [純 TS]
  └─ const docs = subtasks.map((s, i) => ({
       id: ids[i],
       ...s,
       dependsOn: s.dependsOn.map(idx => ids[idx]),  // index → real taskId
     }));

Step 6 — batch write Firestore                  [transaction]
  ├─ for each doc: tx.set(tasksCollection.doc(doc.id), doc)
  └─ also set repos/{repoId}.isBreakingDown = false（解鎖）
```

**Prompt**: `functions/src/prompts/breakdownTask.ts`（純字串）
**Schema**: `functions/src/types.ts`（zod；dependsOn 在這層必須是 `number[]`）
**Flow**: `functions/src/flows/breakdownTask.ts`

**併發鎖（重要）— 防止重複拆解**

兩個成員同時點「AI 拆解」、或同一人連點兩下，會跑兩遍 flow → 同 goal 拆出兩套任務 + 兩倍 GitHub Issue。Callable Function 不自帶併發鎖，必須自己加。

**雙層防護**：

1. **前端**：按下按鈕後立刻把該 button 設成 disabled、顯示 `CircularProgressIndicator`，callable 回傳前不准再按。用 StatefulWidget 的 `_isBreakingDown` flag 控制。

2. **後端**：`breakdownTaskFlow` 開頭跑一個 transaction：讀 `repos/{repoId}.isBreakingDown` → 若已是 `true`，throw `HttpsError('already-exists', ...)` 提示「拆解進行中」；否則 set 為 `true` 並記 `breakdownStartedAt: serverTimestamp()`。後續所有業務邏輯包在 `try ... finally`，無論成功失敗都在 `finally` 把 flag set 回 `false`（用 `.catch(() => {})` 吞錯避免影響主流程）。

**自動解鎖兜底**：若 function 半途 crash 沒走到 finally，flag 會永遠卡 `true`：
- 後端：`scheduledUnstickBreakdown` 排程每 10 分鐘掃所有 repo，找 `isBreakingDown == true AND breakdownStartedAt < now - 5min` → 強制解鎖
- 前端：APP 偵測到 `breakdownStartedAt` 超過 5 分鐘前還在鎖，顯示「拆解卡住？點此重置」按鈕，呼叫 `forceUnlockBreakdown` callable

### 5.2 Flow 2 — `assignTaskFlow`（動態任務分派）

對應 prototype 核心功能 02。

**Input**: `{ repoId: string, taskId: string }`
**Output**: `{ assigneeId: string, reasoning: string }`

**Steps（agentic — 用 OpenAI function calling，讓 agent 自己決定要拉哪些資料）**:

```
Setup — 註冊 4 個 tools:
  • readTeamState(repoId)                → 每位 member 的 { userId, name, githubLogin, discordUserId,
                                            activeIssueCount, expertiseTags, lastActiveAt }
                                            ← 含三組身份對照，下游 RAG 才能把 Discord 對話與 Commit
                                              作者對齊
  • searchMemberCommits(memberId, query) → Firestore vector search on commits
  • getTaskDependents(repoId, taskId)    → 下游有誰會被擋
  • finalizeAssignment(assigneeId, reason) → 最終決定（呼叫即結束 loop）

Agentic Loop (max 5 round):
  ├─ openai.chat.completions.create({ tools, tool_choice: 'auto' })
  ├─ if msg.tool_calls 為空 && finalizeAssignment 已被呼叫過 → 結束
  ├─ else 平行執行 agent 要求的 tools，把結果塞回 messages
  └─ 下一輪
```

Agent 會根據任務內容決定要不要做 vector search、要不要查依賴下游；不是每次都全跑。

### 5.3 Flow 3 — `generateHandoffFlow`（交接文件）

對應 prototype 核心功能 03。

**Input**: `{ repoId: string, taskId: string }` （**通常由 `onTaskUpdated` trigger 自動觸發**）
**Output**: `{ handoffMarkdown: string }`

**Steps（agentic — 完整 function calling loop + 自我審查）**:

```
Setup — 註冊 tools:
  • readTeamRoster(repoId)                      → 同 §5.2 readTeamState；回三組身份對照
                                                  (userId / githubLogin / discordUserId)
                                                  ← Agent 在 draft 時把 Discord/Git author 翻回真實姓名
  • findDownstreamTask(repoId, completedTaskId)
  • listRelatedCommits(repoId, taskId)
  • getCommitDiff(repoId, sha)                  → 經 GitHub API
  • searchDiscordMessages(repoId, query)        → Firestore vector search；每筆會回 authorId
                                                  (Discord snowflake)，Agent 自行用 readTeamRoster
                                                  做姓名對齊
  • searchPastCommits(repoId, query)            → Firestore vector search
  • draftHandoff(markdown)                      → 提交草稿，trigger 自我審查
  • finalizeHandoff(markdown)                   → 通過審查，結束 loop

Phase 1 — Draft Loop (max 5 round):
  ├─ Agent 自由呼叫前 5 個 tools 收集資料
  └─ 最後呼叫 draftHandoff(markdown)

Phase 2 — Self Review (1 round):
  ├─ 餵 draft + downstreamTask.acceptanceCriteria 給 GPT-4o-mini
  ├─ Prompt: "Rate this handoff 1-5 for the next engineer. List gaps."
  └─ if score < 4 && totalRounds < 5 → 回 Phase 1，把 gaps 加進 messages
      else → 呼叫 finalizeHandoff(markdown) 結束
```

**自動觸發**：由 Firestore `onTaskUpdated` trigger 在 task 變 done 時自動呼叫此 flow，結果寫回 `tasks/{taskId}.handoffDoc`。

### 5.4 Flow 4 — `summarizeDayFlow`（時段報告）+ Summary「情報總站」+ Commit Tree

Summary tab 是**開發者情報總站**：把**自選時段**（預設今天；range picker 可選任意區間，上限 92 天）內的 commits + completed tasks + Discord 討論彙整成「人話報告 + 重點 + 阻礙 + commit 訊息整理 + 成員貢獻」，並提供一個 agentic 聊天框讓開發者自然語言追問。Commits tab 則是**commit tree 地圖**（lane-per-author、日期分隔、可滑動），**點任一 commit 由 AI 總結該筆工作**。後端三支 flow：

**(a) `summarizeDayFlow`（agentic — 升級自原本的「非 Agentic 單次」）**

**Input**: `{ repoId, startDate, endDate }`（單日＝兩者相同；callable 相容舊版 `{date}`）
**Output**: `{ summary, highlights[], blockers[], commitThemes[], memberContributions, completedTaskIds[], commitCount, startDate, endDate }`

```
Step 1 — 純 TS 先抓 context（精確計數，不交給 LLM 數）
  ├─ listRangeCommits / listRangeCompletedTasks / readRoster（tools/dailyIntel.ts）
  └─ computeContributions()：author.login → userId 對齊，算每人 tasksDone / commits

Step 2 — agentic function-calling loop（MODELS.fast）
  ├─ tools: listRangeDigests（讀時段內逐日 Discord digest 找 blocker，O(days) 便宜）、
  │         listRangeDiscordMessages（digest 缺漏時的 raw 訊息兜底，cap 500）、
  │         searchPastCommits（跨時段 grounding）、finalizeReport（一次性繳交敘事）
  ├─ agent 自由 drill-down，最後 commit 一份 narrative（summary/highlights/
  │   blockers/commitThemes＝commit 訊息整理；prompt 內 commits cap 200 行）
  └─ 最後一輪 tool_choice 強制 finalizeReport；萬一沒繳交 → 退回 deterministic fallback

Step 3 — 寫 dailyReports/{docId}：單日 docId = date、跨日 = `{start}_{end}`，
         欄位含 startDate / endDate（只有 Cloud Functions 寫得進；前端唯讀）
```

**(b) `dailyBriefChatFlow` / `dailyBrief` callable（agentic 聊天 — 「問 AI 這段期間」）**

仿 `discordChatFlow`：function-calling loop（`listDayCommits` / `listCompletedTasks` / `listRangeDigests` / `searchPastCommits`，前三者以使用者選的時段為界），把 agent 在過程中撈到的 commits 去重後連同答案一起回傳，前端在答案下方顯示「來源 commit」面板。時段由 Summary tab 的 range picker 同步給 report VM 與聊天 VM。

**(c) `explainCommitFlow` / `explainCommit` callable（commit tree 點擊 → AI 工作總結）**

讀 commit doc + linked tasks + 同作者鄰近 commits → 一次 `gpt-4o-mini` 呼叫產出三段式 markdown（做了什麼／脈絡／改了哪裡）。**結果 cache 在 `commits/{sha}.workSummary`**（commits 只有 Cloud Functions 寫得進），重複點擊零成本；`force=true` 重生。前端 Commits tab 的 tree 地圖（lane-per-author CustomPaint、日期分隔）點 row 開 bottom sheet 顯示。**06-05 D2 — GitHub fallback**：branch-graph 上的 commit 可能沒有 Firestore doc（predates all-branch ingest），此時 handler 解析 repo `name` + caller 的 `githubAccessToken`（同 `getCommitGraph`），flow 改打 `githubClient.getCommit` 取 message/files/stats 生成摘要；fallback 路徑不寫 cache（沒有 doc 可寫）。三者缺一即停用 fallback，維持原本 doc-only 行為。

> tasks 的 `status == done` + `updatedAt` range 複合查詢需要 `firestore.indexes.json` 新增的 `tasks status+updatedAt` 索引（live 模式 `firebase deploy --only firestore:indexes`）。

**排程觸發 — 用 Cloud Tasks 扇出，不要 for-loop**

Cloud Functions 單次執行上限 540 秒（9 分鐘）。若每日 18:00 用一個 function 順序跑 50 個 repo 的 `summarizeDayFlow`（每個約 5–10 秒）→ 直接 timeout 崩潰。採用兩階段（isolated sub-agent，AGENTIC_CONCEPTS §5）：

- **`scheduledDailyReport`** — `onSchedule`，每日台北 18:00。**只做扇出**：掃 `apps/gitsync/repos` 所有 ID，對每個 repoId 用 `firebase-admin/functions` `getFunctions().taskQueue('locations/asia-east1/functions/dailyReportWorker').enqueue({ repoId, date })`。`Promise.allSettled` 互不阻擋，回完即結束。

- **`dailyReportWorker`** — **`onTaskDispatched`**（Cloud Tasks queue 函式，非裸 HTTP）。每個 dispatch 只處理一個 repoId → 呼叫 `summarizeDayFlow`。用 onTaskDispatched 的好處：queue 隨函式自動建立（**不需** 手動 `gcloud tasks queues create`）、Admin SDK enqueue 自帶 auth + retry、不引入 `@google-cloud/tasks` 依賴。`retryConfig.maxAttempts=3` 讓 OpenAI 偶發失敗有第二次機會。

### 5.5 Prompt Caching 與成本控制

OpenAI 對 ≥1024 tokens 的 prompt prefix 自動 cache（無需設定，自動省 50%）。**設計每個 flow 時把不變的 system prompt + project context 放最前面**：

```
[system prompt — 不變]            ← cached
[project context — 同 repo 不變]   ← cached
[task-specific query]              ← 每次不同
```

對於高頻函式（`onCommitCreated` → AI summary），改用 `gpt-4o-mini` 把單次成本壓低 10x。

### 5.6 Vector Search 索引與預過濾

**Firestore findNearest 限制**：
1. 必須先建 vector index（不是預設）
2. 同一 query 內若要加 `where` filter，必須在**建立 index 時**就把 filter 欄位一起索引

GitSync 用法：在 `commits` collection group 上建一個 `messageEmbedding` + `repoId` 的複合 vector index。

**建立索引**（部署時一次性）：

```bash
# commits 的 vector index（含 repoId 預過濾）
gcloud firestore indexes composite create \
  --collection-group=commits \
  --query-scope=COLLECTION_GROUP \
  --field-config field-path=repoId,order=ASCENDING \
  --field-config field-path=messageEmbedding,vector-config='{"dimension":1536,"flat":{}}'

# discordMessages 的 vector index
gcloud firestore indexes composite create \
  --collection-group=discordMessages \
  --query-scope=COLLECTION_GROUP \
  --field-config field-path=repoId,order=ASCENDING \
  --field-config field-path=embedding,vector-config='{"dimension":1536,"flat":{}}'
```

或寫在 `firestore.indexes.json`：

```json
{
  "indexes": [
    {
      "collectionGroup": "commits",
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        { "fieldPath": "repoId", "order": "ASCENDING" },
        { "fieldPath": "messageEmbedding", "vectorConfig": { "dimension": 1536, "flat": {} } }
      ]
    }
  ]
}
```

**寫入前必須過濾自動產生的 commit message**

不過濾的話，向量庫會被 `Merge branch ...` / `Bump version 1.2.3` / `Update README.md` 等沒語義價值的訊息污染，且白燒 embedding token。在 `functions/src/tools/commitFilter.ts` 寫一個 `shouldSkipEmbedding(message)` 函式，用 regex 黑名單判斷第一行是否屬於以下類別：

- `Merge branch` / `Merge pull request` / `Merge remote-tracking branch` 開頭
- `Revert "..."` 開頭
- `chore(release|deps|version): bump/update/upgrade ...` 等版本管理 commit
- 純版本號開頭（如 `v1.2.3`、`1.2.3`）
- 預設模板訊息（`Initial commit`、`Update README.md`、`Update .gitignore`）
- 機器人標記（`Auto-merge`、`Automated commit`、`[bot]` 開頭）
- 第一行去除空白後長度 < 5 字元（資訊量太低）

命中任一條 → `onCommitCreated` trigger 直接把 `messageEmbedding` 與 `aiSummary` 設為 null 跳過 OpenAI 呼叫。

**反向依賴查詢的非向量索引（同樣別忘）**

`onTaskUpdated` trigger 在 task 變 done 時要查「誰在等我」，會用到 `where('dependsOn', 'array-contains', completedTaskId)` 結合 `where('status', '==', 'todo')` 的複合查詢。**沒建索引 trigger 會直接 crash**，下游卡片永遠不會被喚醒（demo 當場露餡）。

建立索引（**使用者親跑**，AI 不可）：

```bash
gcloud firestore indexes composite create \
  --collection-group=tasks \
  --query-scope=COLLECTION_GROUP \
  --field-config field-path=dependsOn,array-config=CONTAINS \
  --field-config field-path=status,order=ASCENDING
```

或直接寫入 `firestore.indexes.json`，內容是一個 `indexes` 陣列項目，`collectionGroup: "tasks"`、`queryScope: "COLLECTION_GROUP"`、`fields` 包含兩欄：`dependsOn`（arrayConfig: CONTAINS）與 `status`（order: ASCENDING），然後執行 `firebase deploy --only firestore:indexes`。

**Vector search 查詢時必須帶 `where('repoId', '==', repoId)` 預過濾**

`findNearest` 對 collection group 查詢時，若不加 repoId filter 會 across 所有 repo（跨 repo 洩漏）。寫法是：`db.collectionGroup('commits').where('repoId', '==', repoId).findNearest({ vectorField, queryVector, limit, distanceMeasure: 'COSINE' })`。`queryVector` 用 `FieldValue.vector(embedding)` 包裝。

---

## 6. GitHub 整合

### 6.1 OAuth 登入

用 Firebase Auth 的 GitHub provider，scope 申請：
```
repo            # 讀寫 issue / PR / webhook
read:user       # 讀 user info
```

登入後 `getCredential` 拿到 `accessToken`，存到 `users/{uid}.githubAccessToken`（**正式環境要加密**，可用 Cloud KMS）。

### 6.2 加 Repo 流程 (`addRepo` Callable)

```
1. Flutter 送 githubUrl ─→ Cloud Function
2. 用 user 的 GitHub token + Octokit 驗證 repo 存在且 user 有權限
3. 註冊 webhook：
   POST /repos/{owner}/{repo}/hooks
   - url: https://<region>-<project>.cloudfunctions.net/githubWebhook
   - secret: 隨機產生並存到 repos/{repoId}.webhookSecret
   - events: ["push", "pull_request", "issues", "issue_comment"]
4. 寫 Firestore：apps/gitsync/repos/{repoId}
5. 寫 users/{uid}/repos/{repoId}：role = "owner"
```

### 6.3 Webhook 處理 (`githubWebhook` HTTPS)

`githubWebhook` Cloud Function 收到 GitHub 推來的 POST 後依序處理：

1. **驗 HMAC 簽章** — 從 `x-hub-signature-256` header 取簽章，從 payload 的 `repository.owner.login` + `name` 組出 `repoId` 並去 Firestore 查 `repos/{repoId}.webhookSecret`，以 HMAC-SHA256 驗 raw body。失敗回 401。
2. **Idempotency** — 取 `x-github-delivery` header（GitHub 為每次推送配發的唯一 ID）當 idempotency key，已處理過直接回 200 `dup`。
3. **依 event 類型派發** — 看 `x-github-event` header，分派到 `handlePush` / `handlePR` / `handleIssue`。
4. **回 200** — GitHub 對 webhook 有 10 秒 timeout，逾期會 retry，因此 handler 必須極快回應。

**重要原則**：webhook handler **只負責「raw payload → 標準化 → 寫入 Firestore」**，不解析業務語意、不呼叫 OpenAI、不跨文件更新。所有後續邏輯下沉給 §4.3 對應的 Firestore Trigger（trigger 才有 idempotency key 保護）。這樣 webhook 永遠在毫秒級回應 GitHub（避免 retry 風暴），重邏輯 / 重 retry 集中在 trigger 層。

**`handlePush`** — 只做寫入：對 payload 中每個 commit，寫 `repos/{repoId}/commits/{sha}`，欄位含 `repoId`（冗餘）、`message`、`author`、`url`、`filesChanged`、`added`/`removed`/`modified`、`committedAt`、`branch`。**不解析** commit message 的 `#N`、**不算 embedding**、**不寫 `linkedTaskIds`** — 由 `onCommitCreated` trigger 統一處理。

> **06-05 D1 — ingest ALL branches（不再只收 default branch）**：舊版會 skip 非 default branch 的 push，導致 feature-branch 工作從不進 Firestore（list 看不到、explainCommit 對 branch-graph commit 404）。現在每個 branch 的 push 都寫 doc，並以 push `ref`（去掉 `refs/heads/`）存 `branch` 欄。**First-seen wins**：merge 進 main 會用同一批 sha 重新 push，故改用 per-commit `create()`（碰到已存在的 doc 會丟 ALREADY_EXISTS，忽略即可），避免 `set` 覆蓋 `onCommitCreated` 寫入的 `aiSummary`/`embedding`/`linkedTaskIds`/`workSummary` 並保留原始 branch 歸屬。GitHub push payload 的 `commits[]` 上限 20，超量靠 backfill / PR-merge 流程補。連帶效果：`dailyIntel` 的 range report 現在也會涵蓋 branch commits（時間範圍查詢，desirable）。歷史缺口由一次性腳本 `functions/scripts/backfill-commits.mjs` 補（GitHub REST 逐 branch 列 commit，跳過已存在的 sha，`--dry-run` gated）。

**`handlePR`**（只在 `action == "closed"` 且 `merged == true` 時處理）— 只做寫入：set `pullRequests/{n}`，欄位含 `repoId`（冗餘）、`title`、`state: "merged"`、`commitShas`、`headBranch`、`baseBranch`、`mergedAt`。**不更新** 對應 tasks 的 status — 由 `onPRMerged` trigger 用 transaction 處理。

**`handleIssue`** — 只做寫入：若 issue 對應系統建立的 task，同步該 task 的 `githubIssueNumber` / `state`；其餘交給 trigger。

### 6.4 GitHub API client 包裝

把 Octokit 包成 `functions/src/services/githubClient.ts`，對外暴露兩個函式：

- `getOctokit(userAccessToken)` — 用使用者的 GitHub OAuth token 建立一個 Octokit 實例。
- `getRecentCommits(owner, repo, accessToken)` — 呼叫 Octokit 的 `repos.listCommits`，回最近 20 個 commit（給 `breakdownTaskFlow` 拉專案上下文用）。

之後需要新增其他 GitHub 操作（如建 issue、查 PR diff）就加到同一個檔案，保持「所有 GitHub API 呼叫只走這層」的紀律。

---

## 7. Discord 整合（on-demand 回補版）

> **演進歷程（2026-06-02 再次調整）**：
> 1. 最初規劃 slash command interactions endpoint + Cloud Tasks worker 的完整 bot——**砍掉**（3 秒回應限制太麻煩）。
> 2. 第二版改成「常駐 forwarder bot 即時把每則訊息 POST 進 Firestore」的**單向即時串流**。
> 3. **本版（現行）**：再砍掉「即時轉發」，改成 **on-demand 批次回補**——平常不抓訊息，使用者在 App「Daily → Discord」按 refresh 時，bot 才用 Discord REST API 回補當天訊息，並由 AI 整理成一份**每日 digest**。頻道對照也從 bot 的靜態 `.env` 改成 **Firestore 動態設定**（用 `/gitsync-listen` slash command 綁定）。
>
> 核心理由見 [`MEMORY.md` 2026-06-02 「Discord 改 on-demand 回補 + 頻道對照移進 Firestore」](./MEMORY.md)。Discord 仍是**單向資料源**（成員自然聊天，App 端在需要時才拉），只是抓取時機從「即時」改成「按需」。

### 7.1 三條資料流

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Inbound（on-demand 回補）                                                   │
│                                                                            │
│  App「Daily→Discord」refresh ─▶ requestDiscordFetch (onCall, auth)         │
│                                  └▶ fetchRequests/{id} {repoId,date,        │
│                                                          status:'pending'}  │
│  常駐 bot ─ 輪詢 claimDiscordFetch (secret) ─ 認領一筆 → status:'claimed'   │
│           ─▶ Discord REST GET /channels/{id}/messages（當天、Taipei 日界）  │
│           ─ shouldKeepMessage 第一道過濾 ─▶ POST discordMessageIngest       │
│           ─▶ completeDiscordFetch (secret) → status:'ingested'             │
│                └▶ discordDailyDigestFlow → discordDigests/{date} (AI md)    │
│                   → status:'done'                                          │
│  App ─ 串 fetchRequests/{id}.status + discordDigests/{date} ─▶ UI 顯示      │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────┐    ┌──────────────────────────────────────┐
│ 頻道設定（/gitsync-listen）   │    │ Outbound（任務完成通知，未變）         │
│                              │    │                                        │
│ 在頻道內輸入                  │    │ onTaskUpdated (Firestore Trigger)      │
│ /gitsync-listen url:<repoUrl>│    │ 任務 status → "done" 時觸發            │
│  ─▶ setRepoChannel (secret)  │    │ POST repos.discordWebhookUrl           │
│     arrayUnion channelId →   │    │ （channel webhook，純單向 POST）       │
│     repos.discordChannelIds  │    └──────────────────────────────────────┘
└──────────────────────────────┘
```

**為什麼要走 Firestore queue 中轉**：bot 跑在本機 / VPS，**沒有對外 URL，也沒有 Firestore 憑證**——App 無法直接呼叫 bot，bot 也不能直接寫 Firestore。所以 App 的 refresh 只能「寫一筆 `fetchRequests` 請求」，由常駐 bot 主動輪詢認領；bot 的所有 Firestore 讀寫都透過 secret-auth Cloud Functions 中轉（沿用 `discordMessageIngest` 的 `x-ingest-secret` 模式，不必發 service-account key 給 bot）。

### 7.2 Inbound — on-demand 回補

整條鏈路四個 Cloud Function + bot：

1. **`requestDiscordFetch`**（`onCall`，需登入）— App 的 refresh 按鈕呼叫。驗 `repoId` + `date`（`YYYY-MM-DD`），寫 `fetchRequests/{autoId}` `{repoId, date, status:'pending', requestedBy:uid, createdAt}`，回 `{requestId}`。
2. **`claimDiscordFetch`**（`onRequest`，secret-auth）— 常駐 bot 每 ~5 秒輪詢。撈最舊一筆 `status=='pending'`（用 `collectionGroup('fetchRequests')` 或帶 repoId 過濾），在 transaction 內 re-read 確認仍 pending 才翻成 `claimed`（防兩個輪詢者搶同一筆）；回 `{requestId, repoId, date, channelIds}`（channelIds 來自 `repos/{repoId}.discordChannelIds`）或 `{none:true}`。
3. **bot 回補**（`discord-bot/src/backfill.ts`）— 對該 repo 每個 channelId，用 `channel.messages.fetch`（`before` 游標往回翻頁）抓 **Asia/Taipei 當天 `[00:00, 24:00)`** 區間的訊息，過 `shouldKeepMessage` 第一道過濾，用 `sendWithRetry`（指數退避，見下）POST 到 `discordMessageIngest`。單一 channel 失敗只記 log、不中斷整批。
4. **`completeDiscordFetch`**（`onRequest`，secret-auth）— bot 回補完後呼叫。先把請求標 `ingested`，再跑 `discordDailyDigestFlow`：成功標 `done`、digest 失敗標 `digest_failed`（訊息已寫入，digest 只是錦上添花，失敗不回 5xx）。

**`discordMessageIngest`**（`onRequest`，secret-auth）行為不變（回補 POST 與舊版即時轉發共用此端點）：

1. **驗共享密鑰** — header `x-ingest-secret` 比對 `DISCORD_INGEST_SECRET`，不符回 401。
2. **驗 payload 結構** — body 期望含 `repoId`、`messageId`、`channelId`、`authorId`、`authorName`、`content`、`mentionedUserIds`、`timestamp`。任一缺漏回 400。
3. **Idempotency** — `messageId` 是 Discord 全域唯一 ID，直接當文件 ID，用 `ref.create()` 原子寫入兼去重（重送回 `{dup:true}`）。回補同一天多次也不會重複塞。
4. **寫入** — `repos/{repoId}/discordMessages/{messageId}`，欄位含 `repoId`（冗餘，供 vector 預過濾）、`channelId`、`authorId`、`authorName`、`content`、`mentionedUserIds`、`linkedTaskIds: []`、`timestamp`、`ingestedAt`。
5. **不算 embedding** — 那是 `onDiscordMessageCreated` trigger 的事（職責切分）。

**bot 的能力與限制**（`discord-bot/`，獨立 package，**不在 functions repo 內**）：

- **連線 intents** — `Guilds` / `GuildMessages` / `MessageContent` 三個。即使移除了即時轉發，**`MessageContent` 仍是必開的特權 intent**：REST 回補 `channel.messages.fetch` 只有在開了 Message Content Intent 時才回傳有內容的 `content`。
- **不再有 `MessageCreate` 即時轉發** — 改成輪詢 queue + REST 回補。
- **頻道對照來自 Firestore**（透過 claim 回傳的 `channelIds`），不再讀靜態 `CHANNEL_REPO_MAP`。
- **第一道雜訊過濾** `shouldKeepMessage`（`discord-bot/src/filter.ts`）：bot 訊息忽略、純附件 / 純貼圖忽略、trim 後長度 < 5 忽略、命中 regex 黑名單忽略（純表情字 `haha`/`哈+`/`lol`/`gg`、純應答詞 `ok`/`好`/`收到`/`謝謝`、純 `+1`/`-1`、純 emoji、純連結）。
- **指數退避重試** `sendWithRetry`（`discord-bot/src/ingest.ts`，對抗冷啟動 + 429）：上限 4 次重試、base 1s 指數退避（1s→2s→4s→8s）+ 0–500ms jitter、單次 timeout 8s、4xx 非 429 直接 drop、4 次全失敗 log critical 後丟包。

**第二層防護**：`discordMessageIngest` 端再過一次相同雜訊規則（`functions/src/tools/discordFilter.ts`，與 bot 端 `filter.ts` 同步維護）——防 bot 規則有漏或兩邊不一致。

**增量回補 + 起始日期（per-channel watermark）**：每個綁定頻道在 `repos/{repoId}/discordChannels/{channelId}` 存 `startDate`（app date picker 設）+ `lastMessageId`（watermark）。

- `claimDiscordFetch` 回傳改成 per-channel `[{ channelId, startDate, lastMessageId }]`（相容舊 `channelIds`，缺設定的頻道 startDate/lastMessageId 為 null）。
- bot 對每個頻道用 `channel.messages.fetch({ after })` **往新方向**分頁，cursor = `lastMessageId ?? snowflake(startDate ?? 今天)`，只抓 watermark 之後的新訊息（不再重抓整批；已進 Firestore 的靠 messageId 去重）。snowflake 由日期換算 `((unixMs-1420070400000)<<22)`，`functions/src/tools/discordSnowflake.ts` ↔ `discord-bot/src/snowflake.ts` 須同步。
- bot 把每頻道抓到的最新 messageId 隨 `completeDiscordFetch` 回報 → 更新各頻道 `lastMessageId`（watermark 前進）。
- 起始日期由 callable **`setDiscordStartDate({repoId, startDate})`**（auth）設定：對該 repo 所有頻道寫 `startDate` 並 reset `lastMessageId`，下次從新起點補抓缺口（不重複）。

**範圍雙 cursor + prune（2026-06-03 升級，現行）**：單一起始日期升級成 **`[startDate, endDate]` 範圍**，存在 `repos/{repoId}.discordStartDate` / `discordEndDate`（repo-wide）。理由：舊單 watermark 在「已讀到 7 日、想把起點改回 5 日」時會被 `watermark(7) > snowflake(5)` 卡住而抓不到前面。

- **兩個 cursor**：low = `snowflakeForTaipeiDate(start)`（含），high = `snowflakeForTaipeiDayEnd(end)`（= 隔天 00:00，**exclusive 上界**）。per-channel `lastMessageId` 仍是增量高水位。bot 抓 `after: lastMessageId ?? low`，且**忽略 id ≥ high 的訊息**（不抓 end 之後），watermark 只在範圍內前進。`claimDiscordFetch` 回傳新增 top-level `startDate`/`endDate`。
- **callable `setDiscordRange({repoId, startDate, endDate})`**（auth，取代 app 對 `setDiscordStartDate` 的呼叫）：① 寫範圍到 repo doc（**持久化** → app 重新登入仍記得、預填 range picker）；② reset 各頻道 `lastMessageId`；③ **prune**：刪掉範圍外的 `discordMessages`（timestamp < start 或 ≥ end+1 天）與 `discordDigests/{date}`（date 不在 `[start,end]`）。**破壞性**——縮範圍會真的刪資料，放寬時 bot 重抓回來（messageId 去重不重複）。
- **逐日 digest** `discordRangeDigestFlow`：`completeDiscordFetch` 在 repo 有範圍時對**範圍內每一天**各產一份 `discordDigests/{date}`（沒範圍則退回單日）。省成本 guard：空白日、鎖定日、以及「stored digest 的 `messageCount` == 當天 `count()`」的未變動日都跳過（不呼叫 OpenAI）；上限 92 天。
- App picker 改用 `showDateRangePicker`（預設帶入已存範圍）；Refresh 改成串 `fetchRequests/{id}.status` 等 terminal（`done`/`ingested`/`digest_failed`）才停 spinner 並顯示「Updated」。

### 7.3 頻道設定 — `/gitsync-listen` slash command + 起始日期

頻道對照從靜態 `.env` 改成在 Discord 內動態綁定：

- **bot 註冊 guild slash command** `/gitsync-listen url:<repo-url>`（`discord-bot/src/commands.ts`）。用 **guild command**（非 global）所以即時生效。
- **handler** 取當前 `guildId` + `channelId` + 使用者給的 repo URL，POST 到 `setRepoChannel`，以 **ephemeral** 訊息回覆結果（ephemeral interaction 回覆不吃 Send Messages 權限）。
- **`setRepoChannel`**（`onRequest`，secret-auth）— 用 `parseGithubUrl` 把 URL 轉成 `repoId`（`${owner}_${repo}`，與 `addRepo` 同一套邏輯）；repo 不存在回 404（提示先在 App 加 repo）；存在則 `arrayUnion(channelId)` 進 `repos/{repoId}.discordChannelIds` 並設 `discordGuildId`。
- **一頻道一次**：要監聽多個頻道就在每個頻道各跑一次 `/gitsync-listen`。
- **MVP 授權缺口**：任何知道 repo URL 的 guild 成員都能綁定頻道，demo 可接受；未來硬化項：驗證下指令者是該 repo 成員。

> ⚠️ **OAuth scope 影響**：加了 slash command 後，bot 邀請連結的 scope 要從 `bot` 改成 **`bot` + `applications.commands`**（重新邀請一次）。Bot Permissions 維持唯讀 `View Channels` + `Read Message History`（`permissions=66560`）不變——註冊指令與 ephemeral 回覆都不需要額外權限位元。

### 7.4 AI 每日 digest

`discordDailyDigestFlow`（`functions/src/flows/discordDailyDigest.ts`）由 `completeDiscordFetch` 觸發：

1. 讀該 repo 當天（Asia/Taipei `[00:00,24:00)`）的 `discordMessages`。
2. 空的就 early-return（`markdown:null`，不呼叫 OpenAI）。
3. 否則把 `authorName: content` 串成 transcript，用 `gpt-4o-mini` 整理成 markdown。
4. 寫 `repos/{repoId}/discordDigests/{date}` `{date, markdown, messageCount, generatedAt}`。**鎖定的 digest 不覆寫**（lock 閘，見 §7.7）；範圍回補時這支 flow 被 `discordRangeDigestFlow` 逐日呼叫（見 §7.2）。

App 的「Daily → Discord」tab 串 `discordDigests/{今天}`，把 digest 卡片渲染在訊息列表上方（refresh 按鈕鏡像 Summary tab 的 Regenerate）。供日報 / 未來交接文件 RAG 取用。

### 7.5 Outbound — 任務完成時通知 Discord（未變）

用 Discord channel webhook URL（不需要 bot token、不需要 Cloud Tasks——純單向 POST，沒有 3 秒回應問題）。

`repos/{repoId}` 的 `discordWebhookUrl: string?` 欄位（使用者建立 channel webhook 後填入）。實作 `functions/src/tools/discordNotify.ts` 的 `notifyDiscord(webhookUrl, content)`：webhookUrl 為空直接 return；否則 POST `{ content }`，失敗 `.catch()` 吞錯記 log——通知失敗不該影響主流程。

`onTaskUpdated` trigger：`before.status !== 'done' && after.status === 'done'` 時讀 repo webhook URL，推「✅ \`<task.title>\` 已完成。下一步：\`<nextTask.title>\`」。

### 7.6 不做 / 已移除的部分

- ❌ Discord Interactions HTTP endpoint + Ed25519 簽章驗證（slash command 走 bot 的 gateway 連線處理，不走 HTTP interactions）
- ❌ Cloud Tasks queue + `discordAsyncWorker`、`DISCORD_PUBLIC_KEY` secret
- ❌ **即時 `MessageCreate` 轉發**（本版移除，改 on-demand 回補）
- ❌ **bot 端靜態 `CHANNEL_REPO_MAP`**（改 Firestore `discordChannelIds` + `/gitsync-listen`）
- ❌ 排程 / 自動每日 ingest（只做 on-demand refresh）
- ❌ 給 bot Firebase Admin service account（改用 poll-via-function）

**注意**：bot 仍需 **24/7 常駐**——為了處理 slash command 與輪詢 fetch queue。正式上線可遷至 Cloud Run（min-instance=1）。

### 7.7 AI 聊天 + digest 編輯／鎖定（2026-06-03 新增）

Daily → Discord 下半部從「訊息列表」改成**與 AI 對話的聊天框**；digest 卡片可收合、鎖定、叫 AI 改寫。

**AI 聊天 `discordChat`**（`onCall`，auth）— agentic function-calling loop（沿用 §5.2 `assignTaskFlow` 模式，`gpt-4o-mini`），三個工具，最省成本優先：

- `listDaySummaries` / `getDaySummary`（`functions/src/tools/discordSearch.ts`）— 讀逐日 digest（§7.2 範圍逐日 digest 產生），摘要類問題先走這條，context 從 O(messages) 降到 O(days)。
- `searchDiscordMessages` — 關鍵字搜原始訊息，回傳**分組對話 snippet**：每個命中訊息前後各帶 `CONTEXT_BEFORE/AFTER`（=2）則**同頻道**上下文（`isMatch` 標記命中 vs 脈絡），相鄰命中視窗合併，依命中數→時間排序。**仍是子字串關鍵字比對，非語意**（Discord 訊息尚未做 embedding，`onDiscordMessageCreated` 仍 stub；`firestore.indexes.json` 已預留 `discordMessages.embedding` 向量索引供日後接 `findNearest`）。
- 回傳 `{ answer, snippets }`；UI 把每段 snippet 渲染成叢集（命中強調、脈絡淡化、divider 分隔）。

**digest 編輯／鎖定**（lock 是所有寫 digest 路徑的單一閘）：

- **`setDigestLock({repoId, date, locked})`**（`onCall`）— 寫 `discordDigests/{date}.locked`。鎖住後**自動排程 digest（§7.2/§7.4）與 AI 改寫都跳過**，不覆蓋使用者 pin 的版本。
- **`editDiscordDigest({repoId, date, instruction})`**（`onCall`）— AI 依指令改寫某天 digest 的 markdown；digest 鎖住則拒絕。
- **`botEditDigest`**（`onRequest`，secret-auth）— Discord slash command **`/gitsync-digest instruction:<…> [date]`** 的橋接：由 channelId 反查 repo（`discordChannelIds` array-contains），呼叫同一套改寫流程（鎖住回 409、查無回 404）。

---

## 8. 主題與設計 Token

### 8.1 顏色（取自 prototype `theme.ts`）

```dart
// lib/theme/colors.dart
class AppColors {
  // Primary (深藍系)
  static const primary = Color(0xFF1565C0);
  static const primaryLight = Color(0xFF90CAF9);
  static const primaryDark = Color(0xFF0D47A1);

  // Dark mode accent (橘)
  static const accentDark = Color(0xFFFAB28E);

  // 狀態
  static const success = Color(0xFF29D398);
  static const warning = Color(0xFFFAB795);
  static const error   = Color(0xFFE95678);
  static const info    = Color(0xFF26BBD9);
}

final lightTheme = ThemeData(
  useMaterial3: true,
  brightness: Brightness.light,
  colorScheme: ColorScheme.fromSeed(
    brightness: Brightness.light,
    seedColor: AppColors.primary,
    surface: const Color(0xFFEEF5FF),
  ),
  textTheme: GoogleFonts.notoSansTcTextTheme(),
);

final darkTheme = ThemeData(
  useMaterial3: true,
  brightness: Brightness.dark,
  colorScheme: ColorScheme.fromSeed(
    brightness: Brightness.dark,
    seedColor: AppColors.accentDark,
    surface: const Color(0xFF1C1E26),
  ),
  textTheme: GoogleFonts.notoSansTcTextTheme(),
);
```

### 8.2 圓角 / 間距

| Token | 值 |
|---|---|
| `radiusSm` | 8 |
| `radiusMd` | 12 |
| `radiusLg` | 16 |
| `spacingXs` | 4 |
| `spacingSm` | 8 |
| `spacingMd` | 16 |
| `spacingLg` | 24 |

---

## 9. 模組職責 / 隊員分工建議

> 五人團隊，依模組切分，介面（API contract）以本文件為準。

| 模組 | 負責人 | 主要產出 |
|---|---|---|
| **A. 前端 UI + 導航 + Theme** | 1 人 | 所有 `views/`, `widgets/`, theme, GoRouter |
| **B. 前端 State + Repository** | 1 人 | 所有 `view_models/`, `repositories/`, `models/` |
| **C. 後端 Functions + Firestore Triggers** | 1 人 | Functions callable + triggers + Firestore rules |
| **D. AI Agent (OpenAI Flows + Prompts)** | 1 人 | `functions/src/flows/*` + `functions/src/prompts/*` + `functions/src/tools/*` |
| **E. 整合層 (GitHub Webhook + Discord Bot)** | 1 人 | `githubWebhook`, `discordInteractions`, OAuth、Discord 設定 |

各模組透過本文件 §2 (Schema) + §4 (Functions API) 對齊；不需要互等。

---

## 10. 開發里程碑（建議）

### Sprint 1（1 週）— 骨架
- [ ] A: Theme + GoRouter + 所有頁面殼 (空 UI)
- [ ] B: User / Repo model + Repository + sign in flow
- [ ] C: Firestore rules + flutterfire configure
- [ ] D: `openai` SDK 環境設置 + 一個 hello world flow (含 zod schema)
- [ ] E: GitHub OAuth + addRepo callable（含 webhook 註冊）

### Sprint 2（1 週）— 核心功能 1（任務拆解）
- [ ] A: TasksBoard + AddTodo 3 步驟流程 UI
- [ ] B: TasksBoardViewModel + tasks repository
- [ ] D: `breakdownTaskFlow` 完整實作（含 agentic 驗證）

### Sprint 3（1 週）— 核心功能 2 + 3
- [ ] D: `assignTaskFlow` + `generateHandoffFlow`
- [ ] C: `onTaskUpdated` trigger 串接 handoff
- [ ] A/B: TaskDetailsPage 顯示 handoff + 子任務

### Sprint 4（1 週）— GitHub + Discord 整合
- [ ] E: GitHub webhook 處理 push/PR/issue
- [ ] C: `onCommitCreated` trigger + AI summary（含 idempotency + commit filter）
- [ ] E: 部署獨立 forwarder bot 至本機/VPS + `discordMessageIngest` Cloud Function
- [ ] E: 設定 `repos.discordWebhookUrl` 並驗證 outbound 通知（任務完成時推播）
- [ ] A: DailyView 三個 Tab

### Sprint 5（1 週）— 統計 + 拋光
- [ ] A: StatsView (圓餅圖 / 長條圖 — 套 `fl_chart` 或 `syncfusion`)
- [ ] All: 動畫拋光 (AnimatedList / Hero / SliverAppBar)
- [ ] All: FCM 通知測試
- [ ] All: 修 bug + 跑 demo

---

## 11. 風險與權衡

| 風險 | 緩解 |
|---|---|
| OpenAI 費用超支 | Prompt caching；commit summary 用 gpt-4o-mini；commit / discord 雙層雜訊過濾；非必要功能（每日報）可改成手動觸發 |
| Firestore 查詢慢（依賴圖跨節點） | 不用 graph DB；`dependsOn` 直接存陣列，UI 端組圖；最多 50 個 task 沒問題 |
| GitHub webhook 重送 | `x-github-delivery` 當 webhook 層 idempotency；Trigger 層另用 `event.id` (§4.4 規則 C) |
| **GitHub webhook 高併發爭用** | webhook handler 只寫入 raw doc，全部業務邏輯下沉到 trigger（§6.3 / §4.3 職責切分） |
| **Discord forwarder 丟包（冷啟動 / 429）** | forwarder 內建指數退避重試 + jitter (§7.2 `sendWithRetry`)；4xx 非 429 直接 drop 不再 retry |
| Discord 不能常駐連線 (Cloud Functions 限制) | 由使用者自架 forwarder bot（本機/VPS）即時轉發；正式版可遷至 Cloud Run min-instance=1 |
| **重複拆解任務** (兩人同時點 / 連點) | 前端 button disable + 後端 `isBreakingDown` 分散式鎖 + 5min 排程兜底解鎖 (§5.1) |
| Firebase Auth GitHub provider 拿不到 long-lived token | 第一次拿到的 token 存好；過期再 silent refresh |
| Function cold start（一般） | 高頻函式 (`githubWebhook`、`discordMessageIngest`) 在期末 demo 前加 `minInstances: 1`（會多算錢） |

---

## 12. 環境變數 / Secret 管理

統一用 Firebase Functions 的 `defineSecret`（`firebase-functions/params`）。所有 secret 在 `functions/src/config.ts` 集中宣告，需要該 secret 的 function 在註冊時把它列在 options 的 `secrets` 陣列裡，function 內以 `secret.value()` 讀取。

需要的 secrets：

| Secret 名稱 | 用途 | 誰需要 |
|---|---|---|
| `OPENAI_API_KEY` | 呼叫 OpenAI API | 所有 AI flow / trigger |
| `DISCORD_INGEST_SECRET` | forwarder bot ↔ `discordMessageIngest` 共享密鑰 | `discordMessageIngest` |
| `GITHUB_APP_PRIVATE_KEY` | 若改用 GitHub App 模式；個人 OAuth 模式不用 | `githubWebhook` / `addRepo` |

設定指令（**使用者親跑**，AI 不可）：

```bash
firebase functions:secrets:set OPENAI_API_KEY
firebase functions:secrets:set DISCORD_INGEST_SECRET
```

設定後 Firebase Console 會把 secret 加密存進 Google Secret Manager。Functions 啟動時自動以環境變數注入，本機 emulator 跑時用 `.secret.local` 檔（不入 git，加進 `.gitignore`）。

---

## 13. 後續可擴充（不做進 demo）

- Discord 訊息常駐抓取（改用 Cloud Run + 常駐 discord.js bot）
- Slack 整合（同 Discord 模式）
- VS Code extension（直接從 IDE 看任務 / 觸發 handoff）
- Web 版（Flutter Web；Firebase 已支援）

---

> 完成本文件後，所有 API contract、Firestore schema、AI flow 都已對齊。隊員開工時務必先讀 [`COURSE_METHODS.md`](./COURSE_METHODS.md) 確保 coding style 與課程一致。
