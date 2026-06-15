# Secrets 資料夾

> ⚠️ **這個資料夾整個被 `.gitignore` 排除**（除了 `README.md`、`.gitkeep` 與 `*.example`）。
> **任何含真實 API key 的檔案都不會也不可進 git。** 看到自己編輯的檔案出現在 `git status`，立刻檢查路徑是否寫對。

---

## 0. Fresh clone 必做的一步

`lib/firebase_options.dart` 是 gitignored（避免 web apiKey 入 git）。`flutter analyze` / `flutter run` 需要這個檔存在，所以 clone 完先做：

```powershell
Copy-Item lib/firebase_options.example.dart lib/firebase_options.dart
```

之後分兩條路：

- **Fake backend mode（預設、不用設定 Firebase）** → 不用再做任何事，直接 `flutter run` 就能用 dummy data 跑 — 詳見 [`docs/MEMORY.md` 2026-05-27 Fake backend 模式](../docs/MEMORY.md)
- **Live backend mode（要連真的 Firebase）** → 跑 `flutterfire configure` 它會用真實值覆寫上一行那個 placeholder，然後 `flutter run --dart-define=BACKEND=live`

---

## 1. 為什麼有這個資料夾

GitSync 有三條路線會用到 secret：

| 路線 | 真正用 secret 的地方 | 為什麼還要在這放一份 |
|---|---|---|
| **Cloud Functions（線上）** | Firebase Secret Manager（`firebase functions:secrets:set ...`） | 本機跑 emulator 時 secret 從 `functions/.secret.local` 讀（非本資料夾），但**值與這裡的 `*.env` 必須同步** |
| **Forwarder bot / 本機 script** | `secrets/discord.env` 等 | discord.js 在本機 / VPS 跑，不走 Firebase secret 機制；直接讀檔 |
| **Flutter 本機開發** | `firebase_options.dart`（flutterfire configure 自動產出，含 web apiKey）| Firebase 客戶端 apiKey 不算「秘密」但有人習慣加密放置，可選擇 copy 到此資料夾備份 |

**單一事實來源**：`secrets/` 是「**所有 key 在開發機上的中央儲存**」。各服務啟動腳本從這裡讀，不要散落各處。

---

## 2. 要建立哪些檔案（dev 機本機開發用）

依下表複製 `*.example` 為實際檔，填入真值：

| 實際檔 | 用途 | 取得方式 |
|---|---|---|
| `openai.env` | OpenAI API key | <https://platform.openai.com/api-keys> |
| `discord.env` | Discord forwarder bot token + ingest 共享密鑰 | Discord Developer Portal + 自行生成 32 字隨機字串 |
| `github.env` | (optional) 若改用 GitHub App 模式才需要；OAuth 模式不需要 | <https://github.com/settings/apps> |
| `firebase-admin.json` | Cloud Functions 本機跑 admin SDK 用 service account（emulator **通常不需要**，正式跑才要） | Firebase Console → 專案設定 → 服務帳戶 → 產生新的私密金鑰 |
| `firebase_options.dart` | (optional) `flutterfire configure` 產出的備份；正本必須在 `lib/firebase_options.dart` | 跑 `flutterfire configure` 自動產出 |

---

## 3. 跟 `functions/.secret.local` 的關係

- `secrets/openai.env`、`secrets/discord.env` 是 **「人類可讀的單一來源」**
- `functions/.secret.local` 是 **「Firebase emulator 用的 dotenv 格式檔」**，內容必須與 `secrets/` 同步

每次改 secret 後，請執行（手動，不要由 AI 跑）：

```powershell
# (示意) 把 secrets/*.env 內容 merge 進 functions/.secret.local
Get-Content secrets/openai.env, secrets/discord.env | Set-Content functions/.secret.local
```

或者最簡單：兩邊都手動編輯，但記得同步。

---

## 4. 正式部署（線上 Firebase）

線上 Cloud Functions 不讀 `secrets/` 也不讀 `.secret.local`，**走 Google Secret Manager**：

```powershell
# 由 *人類* 親自跑（AI 禁止；見 AI_AGENT_RULES.md §R2）
firebase functions:secrets:set OPENAI_API_KEY
firebase functions:secrets:set DISCORD_INGEST_SECRET
```

設定後 `firebase deploy --only functions` 時會自動把對應 secret 注入 function 環境變數。

---

## 5. 不要犯的錯

- ❌ 把 `openai.env` rename 成 `openai.env.example` 再 commit（範例檔不可含真實 key）
- ❌ 在 `lib/` 或 `functions/src/` 內 hardcode 任何 key
- ❌ 把 `serviceAccountKey.json` 拖到 `gitsync/` 根目錄（會被 push）
- ❌ 把 `.secret.local` 寄給隊友（用 1Password / Bitwarden / 私訊 share）

---

## 6. 漏出去了怎麼辦

1. **立刻** 到對應平台 revoke 該 key
   - OpenAI: <https://platform.openai.com/api-keys> 找到 key 點 ⋯ → Revoke
   - Discord: Bot token 在 Application → Bot → Reset Token
   - Firebase: service account 在 GCP IAM → 刪除該 key
2. 產新 key 更新 `secrets/` 與 `firebase functions:secrets:set`
3. 通報團隊（在 `docs/MEMORY.md` 記一條），可能要回查 git log 確認真的沒被 push
