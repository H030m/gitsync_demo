# GitSync 部署 Runbook（Cloud / 線上）

> 把整個系統部到真實 Firebase（`gitsync-645b3`）並讓 GitHub + Discord 端到端跑通的完整流程。
>
> **本機開發 / fake mode 請看 [`SETUP.md`](./SETUP.md)**；這份只談「部上雲 + 實際跑通」。
> 架構細節見 [`ARCHITECTURE.md`](./ARCHITECTURE.md)；首次部署的坑見本文件 §9 與 [`SETUP.md §5.9`](./SETUP.md)。

## 0. 前提與心智模型

- **專案**：`gitsync-645b3`、**region**：`asia-east1`（所有 functions / Firestore 同區）。
- **權限**：標 `[owner]` 的步驟需要 `gitsync-645b3` 的 Owner/Editor 權限（嘉駿）。你不是 owner 就請他跑，或請他把你加進專案。
- **工具**：Node 22、Flutter 3.44+、`firebase-tools` ≥15、`flutterfire_cli`、`gcloud`（部分 IAM 指令）。裝法見 [`SETUP.md §0`](./SETUP.md)。
- **一個關鍵開關 `TARGET`**：`cloud`（連雲端，本文件）或 `emulator`（連本機）。App 用 `--dart-define=TARGET=`，bot 用 `.env` 的 `TARGET=`，**兩邊要設一樣**。本文件全程 `TARGET=cloud`。
- **AI 不代跑**：`firebase login` / `deploy` / `secrets:set` / `gcloud` 等都需互動或憑證，一律由人親跑（[`AI_AGENT_RULES §R1/§R2`](./AI_AGENT_RULES.md)）。

---

## 1. Firebase 設定檔（app 端） `[owner 邀請後每人各一次]`

```powershell
firebase login
flutterfire configure --project=gitsync-645b3
```

- 平台至少勾 **Android** + **Web**；覆寫 `lib/firebase_options.dart` 選 **Yes**。
- 會產出真實的 `lib/firebase_options.dart` + `android/app/google-services.json`（兩者皆 gitignored）。
- 讓 git 別一直顯示它們被改：
  ```powershell
  git update-index --skip-worktree lib/firebase_options.dart android/app/google-services.json
  ```

> 前提：你的 Google 帳號已被加入專案（Console -> 專案設定 -> 使用者和權限，role Editor / Firebase Admin）。看不到專案 = 還沒被邀請。

---

## 2. 設定 Secrets `[owner]`

雲端 functions 從 **Google Secret Manager** 讀 secret，**不讀** `functions/.secret.local`（那個只給 emulator）。

```powershell
firebase functions:secrets:set DISCORD_INGEST_SECRET   # 貼一組 32 字隨機字串（bot 端要用同一個）
firebase functions:secrets:set OPENAI_API_KEY          # 貼真實 OpenAI key
```

- `DISCORD_INGEST_SECRET` 是**團隊自訂的共用密碼**（非 Discord 發的），bot 與 function 一致即可。生成：
  ```powershell
  -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 32 | %{[char]$_})
  ```
- **記住這個值**，§6 bot 的 `.env` 要填同一個。
- 改了 secret **一定要重新 deploy functions 才生效**（Gen2 在部署時綁定 secret 版本）。這是 `HTTP 401 bad secret` 的最常見原因——見 §9。

---

## 3. 部署 Functions + Firestore Indexes `[owner]`

```powershell
cd D:\SSFinal\gitsync\functions
npm install
npm run build

cd D:\SSFinal\gitsync
firebase deploy --only functions,firestore:indexes
```

- `firestore:indexes` 會建 [`firestore.indexes.json`](../firestore.indexes.json) 的索引，含 `claimDiscordFetch` 需要的 `fetchRequests`（`status`+`createdAt`）複合索引——**沒建的話 bot 認領會失敗**。
- 只想部 Discord 相關（較快）：
  ```powershell
  firebase deploy --only functions:requestDiscordFetch,functions:claimDiscordFetch,functions:completeDiscordFetch,functions:setRepoChannel,functions:discordMessageIngest,firestore:indexes
  ```
- 吃 `DISCORD_INGEST_SECRET` 的 function：`setRepoChannel` / `claimDiscordFetch` / `completeDiscordFetch` / `discordMessageIngest`。吃 `OPENAI_API_KEY`：`completeDiscordFetch`（digest）+ 各 AI flow。

> 兩個 flow 仍是 stub，被呼叫會丟錯（與 Discord 無關）：`generateHandoffFlow`（task 標 done 時 `onTaskUpdated` 觸發）、`summarizeDayFlow`（Daily->Summary 的 Regenerate）。Discord 的 `discordDailyDigestFlow` 是獨立、已實作。

首次部署到新專案會撞三個坑，照 §9 排。

---

## 4. 啟用 GitHub OAuth（登入用） `[owner]`

1. Console -> Authentication -> Sign-in method 啟用 **GitHub** provider。
2. GitHub -> Developer settings -> OAuth Apps 建一個 App，callback 填
   `https://gitsync-645b3.firebaseapp.com/__/auth/handler`。
3. 把 GitHub 的 Client ID / Client Secret 貼回 Console。

> App 登入時要 `repo` + `read:user` scope（寫死在 `lib/services/authentication.dart`，不用在 Console 設）。不做這步，按「Sign in with GitHub」會 throw。

---

## 5. Discord Application 設定

1. [Discord Developer Portal](https://discord.com/developers/applications) -> 你的 App。
2. **Bot -> Privileged Gateway Intents -> 開 Message Content Intent**（REST 回補要靠它才拿得到訊息內容）。
3. **OAuth2 -> Scopes 勾 `bot` + `applications.commands`**（後者 slash command 必需）；Bot Permissions 只勾 **View Channels** + **Read Message History**（`permissions=66560`）。
4. 用產生的 URL 把 bot 邀請進伺服器（Guild Install）：
   ```
   https://discord.com/oauth2/authorize?client_id=<APP_CLIENT_ID>&permissions=66560&integration_type=0&scope=bot+applications.commands
   ```
5. Bot -> Reset Token，複製 token（§6 要用）。

---

## 6. 設定並啟動 Discord Bot

`discord-bot/` 是獨立的 discord.js 程序（Cloud Functions 無法常駐 gateway 連線，見 [ARCHITECTURE §7](./ARCHITECTURE.md)）。

```powershell
cd D:\SSFinal\gitsync\discord-bot
npm install
Copy-Item .env.example .env   # 若還沒有 .env
```

編輯 `discord-bot/.env`：

| 變數 | 值 |
|---|---|
| `DISCORD_BOT_TOKEN` | §5 複製的 bot token |
| `DISCORD_INGEST_SECRET` | **與 §2 Secret Manager 設的完全一致** |
| `TARGET` | `cloud` |
| `FIREBASE_PROJECT_ID` | `gitsync-645b3` |

bot 會用 `TARGET` + `FIREBASE_PROJECT_ID` 自動推出
`https://asia-east1-gitsync-645b3.cloudfunctions.net`（不用手填整條 URL；要覆寫才設 `FUNCTIONS_BASE_URL`）。

啟動：
```powershell
npm run dev
```
**成功會看到三行**：`logged in as ...` / `[commands] registered in guild ...` / `[backfill] poller started`。
只想測連線：`npm run probe`。

---

## 7. 啟動 App（live + cloud）

```powershell
cd D:\SSFinal\gitsync
flutter run -d chrome --dart-define=BACKEND=live
# TARGET 預設 cloud，不用打；Android 裝置/模擬器把 -d chrome 換成裝置 id
```

啟動後 Settings 頁頂端 banner 應是藍色「Backend: LIVE」。

---

## 8. 端到端驗證（Discord 功能）

1. App 用 GitHub 登入。
2. **Add Repo** 加你要測的 repo（`repoId = owner_repo`，要先存在才能綁頻道）。
3. Discord 該頻道輸入 `/gitsync-listen url:https://github.com/owner/repo.git` -> 回 ephemeral「Now listening this channel for `owner_repo`」。
4. 在該頻道發幾則正常訊息（>=5 字、非 `ok`/`+1`/純表情）。
5. App **Daily -> Discord -> Refresh**：
   - bot terminal 印 `[backfill] claimed ... ingested N`。
   - `fetchRequests/{id}.status` 走 `pending -> claimed -> ingested -> done`。
   - 訊息列表出現對話，上方浮出 AI **Discord digest** 卡片。
6. junk（`ok`/`+1`/純 emoji）被丟、重送回 `{dup:true}` 不重複。

---

## 9. 常見錯誤對照表

| 症狀 | 原因 | 解法 |
|---|---|---|
| bot：`claimDiscordFetch failed: TypeError: fetch failed` | 連不到 function（`TARGET=emulator` 但 emulator 沒跑；或 cloud function 沒部署）| 確認 `TARGET` 與實際後端一致；cloud 要先 deploy、emulator 要先 `firebase emulators:start` |
| bot / slash command：`HTTP 401 {"error":"bad secret"}` | bot 的 `DISCORD_INGEST_SECRET` 不等於雲端 Secret Manager 的值 | 兩邊設成同一個值，**並重新 deploy functions**（§2 / §3）|
| `/gitsync-listen`：`repo not found` | repo doc 不存在 | 先在 App **Add Repo**，或確認 `apps/gitsync/repos/{owner_repo}` 存在 |
| slash command 在 Discord 沒出現 | bot 沒用 `applications.commands` scope 邀請，或沒登入該 guild | 用 §5 的 URL 重新邀請；看 bot log 有無 `[commands] registered` |
| 訊息進來但 `content` 是空 | Message Content Intent 沒開 | Portal -> Bot 開 Message Content Intent |
| `fetchRequests` 停在 `digest_failed` | 雲端 `OPENAI_API_KEY` 是 placeholder / 無效 | `firebase functions:secrets:set OPENAI_API_KEY` 後 redeploy |
| deploy 一直問 `Enter a value for OPENAI_API_KEY` | Secret Manager 沒值 | 先 `firebase functions:secrets:set ...`（測試可填 placeholder）|
| `Build failed: missing permission on the build service account` | 新專案 compute 服務帳戶缺 build 權限 | 給 `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com` 角色 `roles/cloudbuild.builds.builder`（SETUP §5.9）|
| callable 回 `[firebase_functions/internal]`、log `Empty Authorization header` | Gen2 callable 沒開「允許未驗證」| Cloud Run 該服務設 allUsers `run.invoker`（SETUP §5.9）|
| Android build：`google-services.json is missing` | 沒跑 flutterfire configure | §1；或純 fake 開發改跑 `-d chrome` |

---

## 10. 切回本機 emulator（對照）

要全本機跑（不碰雲端）時，把 `TARGET` 兩邊都設成 `emulator`：

```powershell
# 1) emulator（需 Java 11+）
firebase emulators:start --only functions,firestore,auth

# 2) bot：.env 設 TARGET=emulator，DISCORD_INGEST_SECRET 對齊 functions/.secret.local
cd discord-bot ; npm run dev

# 3) app
flutter run -d chrome --dart-define=BACKEND=live --dart-define=TARGET=emulator
```

emulator 的 Firestore 每次重啟清空（除非 `--import/--export`），repo doc 要在 emulator UI（http://127.0.0.1:4000）手建。emulator 的 secret 來源是 `functions/.secret.local`。

---

## 11. 部署前 / 上線待辦

- **`firestore.rules` 仍是 firebase-init 的 30 天大開放規則（2026-06-25 到期）**。線上正式用前要換成 [`ARCHITECTURE §2.2`](./ARCHITECTURE.md) 硬化版，並補上本次新增的 `fetchRequests` / `discordDigests`（`write: if false`；`discordDigests` 開放 member 讀）。到期後 live 模式會被全部拒絕。
- 排程 / Cloud Tasks queue（日報扇出）尚未建：`gcloud tasks queues create daily-report-queue --location=asia-east1`（ARCHITECTURE §5.4）。
- 高頻函式（`githubWebhook` / `discordMessageIngest`）demo 前可加 `minInstances: 1` 降冷啟動（會多算錢）。
