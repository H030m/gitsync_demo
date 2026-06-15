# GitHub OAuth Sign-in (module E)

## Goal

讓 GitSync 的 GitHub 登入在 **live mode** 真正可用：使用者用 GitHub 帳號登入，拿到帶 `repo` scope
的 OAuth access token 並存到 `apps/gitsync/users/{uid}.githubAccessToken`，供下游（`addRepo`、
webhook、AI flows）使用。

## What I already know（從 repo 查得 — 重要）

**OAuth 的 Dart code 幾乎都已實作**，不是從零開始：

- `lib/services/authentication.dart` `_LiveAuthenticationService.logInWithGitHub()` — 已用
  `GithubAuthProvider()..addScope('repo')..addScope('read:user')` + `signInWithProvider` +
  取 `(cred.credential as OAuthCredential?)?.accessToken` + `upsertUserFromAuth`。✅
- `lib/repositories/user_repo.dart` `_LiveUserRepository.upsertUserFromAuth` — 已寫 Firestore
  `apps/gitsync/users/{uid}`（merge）。✅
- `lib/view_models/auth_vm.dart` `signInWithGitHub()` — 已處理 isSigningIn / lastError。✅
- `lib/views/sign_in/sign_in_page.dart` — 已有可運作的 Sign in 按鈕 + 錯誤顯示（標了「照
  prototype 美化」TODO）。✅
- deps：`firebase_auth ^4.4.0`、`firebase_core`、`cloud_firestore` 都在。✅
- 架構參考：ARCHITECTURE §6.1（scope `repo` + `read:user`，token 存 users doc，正式要加密）。

**所以缺的是**：(a) 手動 Firebase Console + GitHub OAuth App 設定（只有人能做）；(b) 端到端驗證；
(c) 少量 code 收尾（見下方 bug + 測試 + TODO 清理）。

## Findings / 潛在問題

- **[Bug] createdAt 被重置**：`upsertUserFromAuth` 每次登入都寫 `createdAt: serverTimestamp()`
  + `SetOptions(merge:true)` → 回訪使用者每次登入 `createdAt` 都被刷新。應只在「文件不存在」時
  設 createdAt。
- **handoff TODO**：`authentication.dart` 頂部的 `TODO(handoff to E module ...)` 與
  `TODO(security: encrypt with Cloud KMS ...)` —— E 模組接手後應依完成度清理/保留。
- **token 刷新**：Firebase 只在「首次 signInWithProvider」回傳 OAuth accessToken，silent
  re-auth 不會再給。token 過期/被撤銷後需重新登入（MVP 可接受，但要知道）。
- **web 平台**：專案會在 Chrome 上跑；`signInWithProvider` 在 web 走 popup/redirect，要確認
  能真的取回 accessToken。

## Manual setup（人/owner 親跑，AI 不執行 — 提供步驟字串）

1. GitHub → Settings → Developers → New OAuth App（Authorization callback URL 填
   `https://gitsync-645b3.firebaseapp.com/__/auth/handler`）。
2. Firebase Console → Authentication → Sign-in method → 啟用 GitHub，貼 Client ID + Secret。
3. 用 `flutter run --dart-define=BACKEND=live` 實測登入。

## Decisions

- **Q1 → code 收尾 + 設定指引**。修 bug + 測試 + TODO 清理 + web 確認 + 補強設定文檔；
  實際 Console 點擊與 e2e 驗證由使用者跑（AI 提供步驟字串）。SignInPage 視覺美化**不做**（歸模組 A）。
- **Q2 → createdAt bug 在本 task 一起修**（就在 OAuth 寫 user 的路徑上）。

## Requirements (final)

1. **修 createdAt bug**：`_LiveUserRepository.upsertUserFromAuth` 改為「文件不存在才設
   `createdAt`」—— 既有使用者重新登入時不得覆蓋 `createdAt`。其餘欄位仍 merge 更新。
   （實作可用 transaction 讀後寫，或 `createdAt` 只在 create 時帶。）
2. **handoff TODO 清理**：`authentication.dart` 頂部的 `TODO(handoff to E module ...)` 在 E 完成後
   移除或改寫為「已完成 + 啟用步驟見 SETUP §B.4」。保留 `TODO(security: KMS)`（仍是未來 prod 工作）。
3. **web 平台確認**：確認 `signInWithProvider` 在 web（Chrome）能取回 OAuth accessToken；
   依 firebase_auth 4.4 慣例，若 web 應走 `signInWithPopup`（`kIsWeb` 分支）才穩，則加上該分支。
   不確定處標註為「需手動 e2e 驗證」。
4. **測試**：用**手刻 fake `AuthenticationService`**（沿用既有 fake 模式，不加新依賴）為 `auth_vm`
   寫單元測試：成功登入回 true、例外設 lastError 回 false、signing-in 期間擋重入。
5. **設定文檔補強**：在 `docs/SETUP.md §B.4` 補上明確 scope（`repo` + `read:user`）與「登入後到
   Settings 看 banner / 確認 token 寫入」的驗證步驟。不重寫已存在的步驟。

## Acceptance Criteria (final)

- [ ] `flutter analyze` 0 error / 0 warning（專案前端測試門檻）。
- [ ] `flutter test` 通過（含新增的 auth_vm 測試）。
- [ ] createdAt：既有使用者重新登入後 `createdAt` 不變（測試或 emulator 驗證其一）。
- [ ] `authentication.dart` 的 E-module handoff TODO 已處理。
- [ ] `docs/SETUP.md §B.4` 補上 scope + 驗證步驟。
- [ ] 提供使用者一份「啟用 GitHub OAuth」可 copy-paste 的手動步驟總結（AI 不執行）。

## Out of Scope

- `addRepo` 之後的 webhook 事件處理（Sprint 4）。
- token 加密（Cloud KMS）—— 正式環境才做，MVP 明文（保留 TODO）。
- SignInPage 的完整視覺還原（模組 A）。
- 端到端 live 登入的實跑（需 owner 先在 Console 啟用 provider；由使用者驗證）。

## Technical Notes

- fake mode（`FakeAuthenticationService`）自動以 demo user 登入，不受本 task 影響。
- AI 禁止項：Firebase Console 操作、`firebase` 部署/secret 指令 —— 只提供 copy-paste 字串
  （AI_AGENT_RULES §R1/§R2）。
