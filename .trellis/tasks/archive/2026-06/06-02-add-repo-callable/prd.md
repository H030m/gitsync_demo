# Implement `addRepo` Callable (add GitHub repo + register webhook)

## Goal

把 `functions/src/handlers/addRepo.ts` 從 `throw HttpsError('unimplemented')` 補成可用的
Callable：使用者送一個 GitHub repo URL，後端驗證權限、（視範圍）註冊 webhook、並在 Firestore
建立對應的 repo 文件，回傳 `repoId`。這是 Sprint 1 模組 C 的上游功能，解鎖後續 webhook /
commit / PR 追蹤。

## What I already know（從 repo / 架構文件查得）

- `addRepo` 是 `onCall`，region `asia-east1`（`REGION`，`admin.ts`）。
- 介面：輸入 `{ githubUrl: string }`，輸出 `{ repoId }`（ARCHITECTURE §4.1）。
- repoId = `${owner}_${name}`（ARCHITECTURE §2.1）。
- Firestore 路徑前綴一律 `apps/gitsync/`（database-guidelines，non-negotiable）：
  - 寫 `apps/gitsync/repos/{repoId}`
  - 寫 `apps/gitsync/users/{uid}/repos/{repoId}`（role = "owner"）
- 取 token：`apps/gitsync/users/{uid}.githubAccessToken`（OAuth scope 含 `repo`，§6.1）。
- GitHub API 紀律：所有呼叫只走 `services/githubClient.ts`（§6.4）。目前該檔有 `getOctokit`、
  `getRecentCommits`；本任務需新增「驗證 repo + 權限」「註冊 webhook」兩個函式。
- Webhook（§6.2）：`POST /repos/{owner}/{repo}/hooks`，
  url = `https://<region>-<project>.cloudfunctions.net/githubWebhook`，
  events = `["push","pull_request","issues","issue_comment"]`，
  secret = 隨機產生存 `repos/{repoId}.webhookSecret`，回傳的 hook id 存 `repos/{repoId}.webhookId`。
- 錯誤碼慣例（error-handling spec）：`failed-precondition`（未登入）、`invalid-argument`（輸入錯）、
  `not-found`（查無）、`already-exists`（重複/鎖）。
- 時間戳用 `FieldValue.serverTimestamp()`；counters 用 `FieldValue.increment`（concurrency Rule A/B）。
- repo doc 欄位 + `members/{uid}` subcollection schema 見 §2.1。

## Assumptions (temporary)

- GitHub OAuth（模組 E）尚未完成，所以實際 `githubAccessToken` 可能還拿不到 → 端到端要等 E。
  本任務以「token 存在」為前提實作，測試用 mock Octokit。
- `githubWebhook` handler 目前仍是 stub（回 200 `note: stub`）。

## Decisions

- **Q1 → best-effort webhook**：完整寫 githubClient 的 webhook 註冊函式，但在 addRepo 內用
  try/catch 包起來。註冊失敗（OAuth 未完成 / 部署 URL 未知 / 權限不足）只記 log，不擋整個流程；
  repo doc 照樣建立，`webhookId` / `webhookSecret` 留空（或 secret 先產好、webhookId 留 null）。
  理由：githubWebhook 收端與 OAuth 給 token 端都還是 stub，現在無法端到端跑通；best-effort 讓本任務
  現在就能交付可測成果，E 模組完成後註冊自動生效。**已知後果**：在註冊真正生效前加入的 repo 之後
  需要一個 backfill（Sprint 4 補註冊），記在 Out of Scope。

- **Q2 → 只做 addRepo**。removeRepo 另開 task（驗證 owner、刪 webhook、刪 docs，邏輯不同）。
- **Q3 → 重複加入報 `already-exists`**。addRepo 前先查 `apps/gitsync/repos/{repoId}` 是否已存在，
  存在則 throw `HttpsError('already-exists', ...)`。
- **Q4 → 一併建 `members/{uid}`**（role=owner, activeIssueCount=0, completedTaskCount=0,
  lastActiveAt=serverTimestamp）。後續 assignTask 需要這些計數器。
- **Q5（預設，未爭議）→ 原子寫入**：repo doc + `users/{uid}/repos/{repoId}` + `members/{uid}`
  用一個 `WriteBatch` 一次 commit，避免部分寫入。webhook 註冊（best-effort）在 batch commit
  「之前」嘗試 —— 成功就把 webhookId/secret 一起寫進 batch；失敗就留空再 commit。

## Requirements (final)

1. 驗證 `request.auth`，未登入 → `failed-precondition`。
2. 驗證 `githubUrl` 存在且可解析出 `{ owner, repo }`（支援 `https://github.com/owner/repo`
   與 `owner/repo` 等常見格式），否則 `invalid-argument`。
3. 取 caller 的 `apps/gitsync/users/{uid}.githubAccessToken`；缺 token → `failed-precondition`
   （引導去完成 GitHub 授權）。
4. 經 `githubClient` 用 token 驗證 repo 存在且有 admin/push 權限（`repos.get`，讀 `permissions`），
   查無/無權 → `not-found` / `failed-precondition`。同時取回 `githubRepoId`、`defaultBranch`。
5. repoId = `${owner}_${name}`；若 `apps/gitsync/repos/{repoId}` 已存在 → `already-exists`。
6. **best-effort 註冊 webhook**（githubClient 新增函式）：events
   `["push","pull_request","issues","issue_comment"]`，url 由執行期專案推導
   （`https://${REGION}-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/githubWebhook`），
   secret 隨機產生。成功 → 取回 `webhookId`；失敗 → log + `webhookId=null`，不中斷。
7. 用一個 `WriteBatch` 原子寫入：
   - `apps/gitsync/repos/{repoId}`（name, url, githubRepoId, defaultBranch, webhookId,
     webhookSecret, memberIds=[uid], isBreakingDown=false, createdAt, createdBy=uid）
   - `apps/gitsync/users/{uid}/repos/{repoId}`（role="owner"）
   - `apps/gitsync/repos/{repoId}/members/{uid}`（role="owner", activeIssueCount=0,
     completedTaskCount=0, lastActiveAt）
8. 回傳 `{ repoId }`。
9. githubClient 新增：`verifyRepoAccess(owner, repo, token)`、`registerWebhook(owner, repo,
   token, { url, secret, events })`（所有 GitHub API 呼叫只走這層）。

## Acceptance Criteria (final)

- [ ] `npm --prefix functions run typecheck` 通過。
- [ ] `npm --prefix functions run lint` 通過。
- [ ] 單元測試（mock Octokit + Firestore）覆蓋：
  - [ ] 未登入 → `failed-precondition`
  - [ ] 缺/壞 `githubUrl` → `invalid-argument`
  - [ ] 缺 token → `failed-precondition`
  - [ ] repo 不存在/無權限 → `not-found` / `failed-precondition`
  - [ ] 重複加入 → `already-exists`
  - [ ] 成功：三份 doc 都寫入、回傳正確 repoId
  - [ ] webhook 註冊失敗時仍成功建 repo（webhookId=null），驗證 best-effort
- [ ] 所有 GitHub API 呼叫都經 `githubClient`（無散落的 Octokit import）。

## Definition of Done

- 測試新增/更新（mock GitHub API；可在 emulator 或純單元層級）
- Lint / typecheck 綠
- 行為若改變則更新 docs/notes（必要時 MEMORY.md 記錄新欄位/決策）
- 風險路徑（部分失敗）有明確處理策略

## Out of Scope (explicit)

- GitHub OAuth 登入流程本身（模組 E）。
- `githubWebhook` handler 的實際事件處理（仍是 stub，Sprint 4）。
- Firestore security rules 的 production 版本（owner TODO）。
- Webhook backfill（幫 best-effort 期間加入、沒成功註冊 webhook 的 repo 補註冊）→ Sprint 4。

## Technical Notes

- 參考實作慣例：`handlers/breakdownTask.ts`（auth + arg 驗證 + 鎖）、`handlers/setDiscordWebhook.ts`
  （`db.doc('apps/gitsync/repos/${repoId}').update(...)`）。
- 路徑鏡像：`lib/repositories/firestore_paths.dart`。
- GitHub client：`functions/src/services/githubClient.ts`（新增函式放這）。

## Open Questions 待逐一釐清（見上）
