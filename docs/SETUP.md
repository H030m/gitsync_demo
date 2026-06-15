# GitSync 本機環境設定教學

> 給隊員在新機器上把 GitSync 開起來的完整步驟。**走完路徑 A 大概 10 分鐘**就能看到 app 跑起來（不需 Firebase）；之後想接真實 Firebase 再走路徑 B。

---

## 0. 前置工具（一次性安裝）

### 0.1 Flutter SDK
- 裝 [Flutter 3.44+](https://docs.flutter.dev/get-started/install)（含 Dart 3.12+）
- 跑 `flutter doctor`，把紅色項目通通解掉（除了你不會用到的平台例如 iOS 在 Windows 上的部分）

### 0.2 Node.js 22
- 從 [nodejs.org](https://nodejs.org/) 裝 LTS（v22.x），檢查 `node --version` / `npm --version`
- **必須是 22**，因為 `functions/package.json` 寫死 `"engines": { "node": "22" }`

### 0.3 Firebase CLI
```powershell
npm install -g firebase-tools
firebase --version    # 應該 ≥ 15.x
```

### 0.4 FlutterFire CLI（連 Flutter ↔ Firebase 的）
```powershell
flutter pub global activate flutterfire_cli
```
- 如果跑完 `flutterfire` 指令顯示「not recognized」，把 Dart pub global 加到 PATH：
  - Windows：`%APPDATA%\Pub\Cache\bin`

### 0.5 Git
- 應該已經有了，沒有的話裝 [Git for Windows](https://git-scm.com/download/win)

---

## 1. Clone repo（一次性）

```powershell
git clone https://github.com/H030m/gitsync.git
cd gitsync
```

> 如果你沒有 push 權限，先 fork 後再 clone 自己的 fork。

---

## 2. 共用 setup（**任何路徑都要做**）

### 2.1 安裝 dependencies

```powershell
# Flutter side
flutter pub get

# Cloud Functions side
cd functions
npm install
cd ..
```

### 2.2 **必做** — 複製 firebase_options placeholder

`lib/firebase_options.dart` 是 gitignored（避免 web apiKey 入 git，[詳見 MEMORY.md](./MEMORY.md)）。fresh clone 後沒這檔，`flutter analyze` / `flutter run` 都會編譯失敗。執行：

```powershell
Copy-Item lib/firebase_options.example.dart lib/firebase_options.dart
```

### 2.3 確認 analyze 通過

```powershell
flutter analyze
```
應該看到 `1 issue found.` 且裡面只有 1 個 info-level（`use_null_aware_elements`）— 那是預期的。**0 error / 0 warning** 才算過。

---

## 3. 二選一：選一條路繼續

### 路徑 A — Fake backend（**推薦先走這條**）

不需要 Firebase / OpenAI / GitHub OAuth 任何設定。直接跑：

```powershell
# 二選一：用 dart-define 強制 fake；或省略，吃 AppConfig.defaultBackend（目前預設 fake）
flutter run --dart-define=BACKEND=fake
# or
flutter run
```

選一個裝置（Chrome / Windows / Android emulator），按下去。

#### ✅ 完成標準
- App 啟動後**直接到 RepoList 頁**（fake mode 自動以 demo user 簽入，跳過 SignInPage）
- 你看到 `team17/gitsync` 一個 repo
- 點進去看到三個欄位的看板（To do / In progress / Done），共 8 個假任務
- Daily Tab 看到 dummy daily report + 3 個 commit + 3 條 Discord 訊息
- Settings 頁頂端有橘色 banner 寫「Backend: FAKE (dummy data)」

如果你今天只是要寫 UI / VM / model，**到這就夠了，不用再往下做**。

---

### 路徑 B — Live backend 連團隊既有 Firebase（`gitsync-645b3`）

#### 前提
**你必須被 project owner（嘉駿）邀請加入 Firebase project**。沒被邀請的話 `flutterfire configure` 會列不出 `gitsync-645b3`。

> Owner 親跑（不是 AI）：到 [Firebase Console → 專案設定 → 使用者和權限](https://console.firebase.google.com/project/gitsync-645b3/settings/iam) 加你的 Google 帳號，role 給 `Editor` 或 `Firebase Admin`。

#### B.1 Firebase 登入

```powershell
firebase login
```
彈出瀏覽器，用**被邀請的那個 Google 帳號**登入。

```powershell
firebase projects:list
```
應該看得到 `gitsync-645b3`。看不到 = 你不在 project 成員裡，回去找 owner。

#### B.2 用 flutterfire configure 拉真實 Firebase config

```powershell
flutterfire configure --project=gitsync-645b3
```

互動選單會問：
1. 要設定哪些平台（Android / iOS / Web / Windows 等）── 至少勾你會用的，建議全勾以後不用再跑
2. 是否覆寫 `lib/firebase_options.dart` → **Yes**

跑完它會：
- 覆寫 `lib/firebase_options.dart` 為含真實 apiKey 的版本（**這檔已被 gitignored**，不會進 commit）
- 在 `android/app/google-services.json` 寫入 Android 的設定（**也已 gitignored**）
- 給 iOS / macOS 寫 `GoogleService-Info.plist`

> **遇到 `firebase apps:sdkconfig web ... failed` 短暫錯誤**：通常是 Firebase 後端 propagation 沒跟上，重跑一次 `flutterfire configure` 就會過。

#### B.3 拿 secret（可選，給要實際呼 OpenAI / Cloud Functions 的人）

如果你只是要連 Firestore + Auth，到此就夠。

如果你要跑 **Cloud Functions emulator** 或部署 functions，需要 OpenAI / Discord 共享密鑰：

1. 跟 owner 要 `OPENAI_API_KEY` / `DISCORD_INGEST_SECRET`（透過 1Password / 私訊 / Signal — **不要用 Email / 任何進 git 的地方**）
2. 本機填入：
   ```powershell
   Copy-Item functions/.secret.local.example functions/.secret.local
   # 用編輯器把真值填進 functions/.secret.local
   
   Copy-Item secrets/openai.env.example secrets/openai.env
   Copy-Item secrets/discord.env.example secrets/discord.env
   # 用編輯器填值
   ```
3. **正式部署**到 Cloud Functions 的話走另一條路 — `firebase functions:secrets:set OPENAI_API_KEY`，但這指令通常**只 owner 親跑一次**，其他人不必跑。

#### B.4 (可選) 啟用 GitHub OAuth provider

Fake mode 自動以 demo user 簽入，跳過真實登入。Live mode 想真的用 GitHub 登入，需要 owner 親跑：

1. 到 [Firebase Console → Authentication → Sign-in method](https://console.firebase.google.com/project/gitsync-645b3/authentication/providers)
2. 啟用 GitHub provider
3. 到 [GitHub Settings → OAuth Apps](https://github.com/settings/developers) 建一個 OAuth App，callback 填 Firebase Console 顯示的那個 URL（`https://gitsync-645b3.firebaseapp.com/__/auth/handler`）
4. 把 GitHub 的 Client ID + Client Secret 貼回 Firebase Console

> **OAuth scopes**：登入時 app 會向 GitHub 要 `repo` + `read:user` 兩個 scope（程式碼寫死在
> `lib/services/authentication.dart`，不需在 Console 設定）。`repo` 讓下游 `addRepo` / webhook /
> AI flows 能讀寫使用者的 repo；`read:user` 拿到 GitHub 帳號資訊。第一次登入時 GitHub 的授權頁
> 會列出這兩項，使用者要按 **Authorize**。

> **登入後驗證**（owner 啟用 provider 後實測一次）：
> 1. `flutter run --dart-define=BACKEND=live`，在 SignInPage 按「Sign in with GitHub」。
> 2. 登入成功後，Settings 頁頂端 banner 應顯示藍色「Backend: LIVE (Firebase)」。
> 3. 到 [Firestore Console](https://console.firebase.google.com/project/gitsync-645b3/firestore)
>    打開 `apps/gitsync/users/{uid}`，確認文件有寫入 `githubAccessToken`（非空字串）。
>    若該欄位缺失或為空，代表 OAuth token 沒被取回 → 多半是 callback URL 或 scope 沒設對。

> 這步不做的話，按 SignInPage 的「Sign in with GitHub」會 throw，但**不影響其他人在 fake mode 上開發**。

#### B.5 跑起來

```powershell
flutter run --dart-define=BACKEND=live
```

#### ✅ 完成標準（路徑 B）
- App 啟動進到**真實 SignInPage**（不再跳過）
- Settings 頁頂端 banner 變成藍色「Backend: LIVE (Firebase)」
- 按 Sign in 後（如果你做了 B.4）能用 GitHub OAuth 登入
- 登入後看到的 repo / task 是來自真實 Firestore（**目前是空的，因為還沒有人塞資料**）

#### B.6 Firebase Cloud Messaging (web)

Chrome 上要真的收到 FCM push，需要一把 **VAPID public key**（mobile FCM 不需要這個，
所以只影響 web）。沒設的話 app 仍會正常啟動，只是 console 會印一行
`[FCM web] FCM_VAPID_KEY not set` 提醒，不會拿到 token。

拿 key：Firebase Console → 專案設定 → **Cloud Messaging** tab →
**Web configuration** → **Web Push certificates** → **Generate key pair** →
複製顯示出來的 public key 字串。

跑的時候多帶一個 dart-define：

```powershell
flutter run -d chrome --dart-define=BACKEND=live --dart-define=FCM_VAPID_KEY=<貼上>
```

這把 key 是 **PUBLIC** 的（Firebase 自己叫它 "Web Push certificate public key"），
分享出去沒安全問題；用 `--dart-define` 純粹是順便不讓它進 git。

---

### 路徑 C — Live mode 用你自己的 Firebase project（給想完全隔離測試的）

不建議多人都這樣做（資料會散落），但偶爾你想實驗破壞性東西不想動到團隊資料時可以。

#### C.1 開新 project

到 [console.firebase.google.com](https://console.firebase.google.com) 建一個新專案，名字隨便。

#### C.2 啟用必要服務

在新專案裡開啟：
- **Firestore Database**（用 Native 模式，location 選 `asia-east1` 跟團隊一致）
- **Authentication**（GitHub provider 自選要不要設）
- **Cloud Functions**（需要付費的 Blaze plan，但開發階段免費額度夠用）
- **Cloud Messaging**（FCM，如果要測 push）

#### C.3 連到本地

```powershell
firebase login
flutterfire configure   # 選你剛建的 project，覆寫 firebase_options.dart
```

#### C.4 部 rules + indexes

```powershell
firebase use <你的-project-id>
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

> 這兩條會把 [`firestore.rules`](../firestore.rules) + [`firestore.indexes.json`](../firestore.indexes.json) 推上你的 project。**目前 `firestore.rules` 是 firebase init 寫的 30 天大開放規則** — 開發夠用，正式用前要換成 [ARCHITECTURE.md §2.2](./ARCHITECTURE.md#22-firestore-security-rules) 那版（owner TODO）。

#### C.5 跑 Cloud Functions

```powershell
cd functions
npm run build
firebase deploy --only functions   # 第一次部 functions 可能要 5-10 分鐘
```

#### ✅ 完成標準（路徑 C）— 同路徑 B，但 Firebase project 是你自己的

---

## 4. 本地 emulator 用法（可選，**強推**）

不想每次測都打到線上 Firebase？用 emulator suite：

```powershell
cd d:\SSFinal\gitsync
firebase emulators:start
```

這會啟動：
- Firestore on `localhost:8080`
- Auth on `localhost:9099`
- Functions on `localhost:5001`
- UI on `localhost:4000`（瀏覽器打開可以看 / 編輯 Firestore 文件）

要讓 Flutter app 連 emulator 而非線上 Firebase，需要在 `main.dart` 加一段（**TODO，目前還沒做**）：

```dart
if (kDebugMode && Platform.environment['USE_EMULATOR'] == '1') {
  FirebaseFirestore.instance.useFirestoreEmulator('localhost', 8080);
  FirebaseAuth.instance.useAuthEmulator('localhost', 9099);
  FirebaseFunctions.instance.useFunctionsEmulator('localhost', 5001);
}
```

> 這段還沒加。要的人自己補，或開個 issue 提一下。Fake mode 已經能滿足多數本機開發需求。

---

## 5. 常見錯誤排查

### 5.1 `Target of URI doesn't exist: 'firebase_options.dart'`
你忘了 §2.2 的 `Copy-Item`。回去做。

### 5.2 `UnsupportedError: firebase_options.dart is still the placeholder`
你在 LIVE mode 跑但 `firebase_options.dart` 還是 example 內容。回去做 §3 路徑 B 的 `flutterfire configure`，或改用 fake mode。

### 5.3 `FirebaseCommandException: Failed to get WEB app configuration`
Firebase 後端短暫 propagation hiccup。**重跑一次 `flutterfire configure`** 通常就過。還不行：
```powershell
firebase login --reauth
```

### 5.4 `flutter pub get` 卡住 / 拉不到套件
- 確認網路通
- 試 `flutter clean` 然後重跑
- 課程指定的版本 (`provider 6.1.2`、`go_router 14.0.2`、`firebase_core 2.26.0`...) 與 Dart 3.12 有相容性 warning 是正常的，pub 仍然能解

### 5.5 `npm install` 在 functions/ 失敗
- 確認 `node --version` 是 22.x。其他 major version 會被 `engines: { node: '22' }` 拒絕
- 試 `npm cache clean --force` 後重跑

### 5.6 `firebase emulators:start` 報 Java 找不到
emulator 需要 Java 11+。裝 [Adoptium Temurin JDK](https://adoptium.net/) 後重開 terminal。

### 5.7 我的 `git status` 看到 `lib/firebase_options.dart` 被改動了
**這是預期的**，因為 `flutterfire configure` 改了你的本地檔案。**不要 `git add` 那個檔**。`.gitignore` 已經排除它，但因為它一度被歷史 commit track 過，git 仍會把改動列出來。可以一次性告訴 git「假裝這檔沒變」：

```powershell
git update-index --skip-worktree lib/firebase_options.dart
git update-index --skip-worktree android/app/google-services.json
```

跑過之後 `git status` 就乾淨了。要還原這個設定：

```powershell
git update-index --no-skip-worktree lib/firebase_options.dart
```

### 5.8 `flutter run --dart-define=BACKEND=live` 開到 task 看到 `unimplemented` 錯誤
這是預期。`functions/src/flows/*.ts` 目前都還是 stub（`throw new Error('not implemented yet')`），等 D 模組（AI Agent owner）補完才會回真實資料。在此之前用 fake mode 就好。

### 5.9 首次部署 Cloud Functions 的三連坑（2026-06-02 實戰記錄）

第一次 `firebase deploy --only functions:...` 到一個全新專案會連環撞到三個非程式問題，依序排掉即可：

**(a) deploy 一直跳 `Enter a value for OPENAI_API_KEY`（即使只 target addRepo）**
CLI 載入整包 code 時看到 `config.ts` 宣告了 `defineSecret`，Secret Manager 裡卻沒值就會問。先把 secret 設好就不再問（測非 AI 函式可填佔位值）：
```bash
firebase functions:secrets:set OPENAI_API_KEY        # 沒有真 key 就填 placeholder-replace-later
firebase functions:secrets:set DISCORD_INGEST_SECRET # 同上
```
> `addRepo` / `githubWebhook` 不讀這些 secret；之後部署 AI 函式前再換真值。

**(b) `Build failed: missing permission on the build service account`**
新專案的預設 compute 服務帳戶沒有 build 權限（Google 政策改動）。給它角色（`<專案號>` 看錯誤訊息裡的 `project=...`）：
```bash
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.builder"
# 仍失敗再補 roles/artifactregistry.writer、roles/logging.logWriter
```
角色名在 Console 顯示為「Cloud Build Service Account」；**對象要選 `-compute@developer` 那個帳戶**，不是 `@cloudbuild` 的。

**(c) app 呼叫 callable 回 `[firebase_functions/internal] internal`，log 顯示 `Empty Authorization header`**
Gen2 callable 需要 Cloud Run 服務「允許未驗證呼叫」（真正的登入檢查在函式內做）。新部署沒自動授權就全被擋。修：Console → Cloud Run → 點該服務（名稱小寫如 `addrepo`）→ 安全性 → 選**「允許公開存取」**；或：
```bash
gcloud run services add-iam-policy-binding <service-name> \
  --region=asia-east1 --member=allUsers --role=roles/run.invoker
```
安全性不受影響——函式第一行 `if (!request.auth)` 仍擋未登入者。

> 用 `firebase functions:log --only <name>` 看雲端錯誤。`internal` 多半是「呼叫被擋在函式外」(c) 或「函式內丟非 HttpsError 例外」。

### 5.10 Android 編譯卡 `File google-services.json is missing`

`android/app/google-services.json` 已 gitignore 且 repo **沒有範本**，所以 fresh clone 對
Android 裝置/模擬器編譯時，Gradle 的 `:app:processDebugGoogleServices` 一定失敗——
**即使是 fake mode**（Chrome/Web 不受影響）。二選一：

1. **要連真 Firebase**：跑 `flutterfire configure --project=gitsync-645b3`（會自動產生此檔）。
2. **只跑 fake mode**：放一個佔位檔 `android/app/google-services.json` 即可過編譯
   （fake mode 執行期不會讀它的值）。最小內容：`project_info.project_id: "gitsync-645b3"`、
   `client[0].client_info.android_client_info.package_name: "com.example.gitsync"`，
   其餘 `project_number` / `mobilesdk_app_id` / `api_key` 填假值（格式對即可）。

另外模擬器空間不足時 `INSTALL_FAILED_INSUFFICIENT_STORAGE`：用
`adb shell pm list packages -3` 找舊練習 app、`adb uninstall <package>` 清掉即可。

---

## 6. Setup 完成檢查清單

走完之後對照一遍：

- [ ] `flutter doctor` 沒紅
- [ ] `node --version` = 22.x
- [ ] `firebase --version` ≥ 15
- [ ] `flutterfire --version` 跑得出來
- [ ] `git clone` 完成、`cd gitsync` 進去了
- [ ] `flutter pub get` 過
- [ ] `cd functions && npm install` 過
- [ ] `Copy-Item lib/firebase_options.example.dart lib/firebase_options.dart` 跑過
- [ ] `flutter analyze` 顯示 0 error / 0 warning
- [ ] **路徑 A**：`flutter run` 看到 RepoList + dummy data → ✅ 完工
- [ ] **路徑 B**：被加入 `gitsync-645b3` project + `flutterfire configure --project=gitsync-645b3` 跑過 → 進 LIVE mode 看到真實 (空的) Firestore

---

## 7. 還有問題？

- 看 [`docs/AI_AGENT_RULES.md`](./AI_AGENT_RULES.md) — 含 AI agent 工作流規範 + 常見坑
- 看 [`docs/MEMORY.md`](./MEMORY.md) — 團隊歷次決策 + 為什麼這樣做
- 看 [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — 整體系統設計
- 看 [`secrets/README.md`](../secrets/README.md) — secret 管理細節
- 在 Discord 群問同學
