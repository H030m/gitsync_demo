# Implement `removeRepo` Callable

## Goal

把 `functions/src/handlers/removeRepo.ts` 從 `unimplemented` 補成可用：驗證呼叫者是 repo owner →
（best-effort）刪除 GitHub webhook → 刪除 Firestore 文件。為 `addRepo` 的對稱反向操作。

## What I already know（從 repo 查得）

- 介面（ARCHITECTURE §4.1）：輸入 `{ repoId }`，輸出 `{}`。client 端 `functions_service.removeRepo`
  已接好 `_callable('removeRepo').call({repoId})`。
- `addRepo` 寫入的東西（要反向清掉）：
  - `apps/gitsync/repos/{repoId}`（含 `webhookId`、`webhookSecret`、`memberIds[]`、`createdBy`）
  - 每個 member 的 `apps/gitsync/users/{uid}/repos/{repoId}`
  - `apps/gitsync/repos/{repoId}/members/{uid}`
  - 以及 repo 之後累積的子集合：`tasks` / `commits` / `pullRequests` / `discordMessages` / `dailyReports`
- repoId 格式 `${owner}_${repo}`（可從 repo doc 的 `name`=`owner/repo` 或 url 取回 owner/repo 來刪 webhook）。
- githubClient 現有 `getOctokit` / `verifyRepoAccess` / `registerWebhook` —— 本任務需新增 `deleteWebhook`。
- firebase-admin 內建 `db.recursiveDelete(ref)`：刪一個 doc + 其所有子集合，適合清 repo 整棵。
- 錯誤碼慣例：`failed-precondition`（未登入/非 owner）、`invalid-argument`、`not-found`、`permission-denied`。
- 路徑前綴一律 `apps/gitsync/`；GitHub 呼叫只走 `services/githubClient.ts`。

## Decisions

- **Q1 → 只有 owner**：以 `repos/{repoId}/members/{uid}.role === 'owner'` 判定（fallback 看 repo doc
  `createdBy === uid`）；非 owner → `permission-denied`。
- **Q2 → 遞迴刪除**：用 `db.recursiveDelete(repoRef)` 一次清掉 repo doc + 所有子集合（members /
  tasks / commits / pullRequests / discordMessages / dailyReports）。
- **Q3 → webhook best-effort**：用 repo doc 的 `webhookId` 去 GitHub 刪 hook；失敗只 log，不擋 Firestore 清除。

## Requirements (final)

1. 未登入 → `failed-precondition`。
2. 缺 / 壞 `repoId`（非字串/空） → `invalid-argument`。
3. 讀 `apps/gitsync/repos/{repoId}`；不存在 → `not-found`。
4. 驗證呼叫者 owner（members/{uid}.role==='owner' 或 createdBy===uid）→ 否則 `permission-denied`。
5. **best-effort 刪 webhook**：若 repo doc 有 `webhookId`，從 `name`（`owner/repo`）或 url 解析出
   owner/repo，用呼叫者的 `githubAccessToken` 呼叫新的 `githubClient.deleteWebhook(owner, repo,
   token, hookId)`。失敗（無 token / 過期 / hook 已不存在 / 無權限）只 `logger.warn`，繼續。
6. **清 Firestore**：
   - 先刪每個 `memberIds` 的 `apps/gitsync/users/{memberUid}/repos/{repoId}` 指標。
   - 再 `db.recursiveDelete(db.doc('apps/gitsync/repos/${repoId}'))`（repo doc + 所有子集合）。
7. 回 `{}`。
8. githubClient 新增 `deleteWebhook(owner, repo, token, hookId)`（DELETE /repos/{owner}/{repo}/hooks/{id}）。

## Acceptance Criteria (final)

- [ ] `npm --prefix functions run lint` / `typecheck` / `test` 綠。
- [ ] 單元測試（mock Octokit + Firestore）涵蓋：未登入 → failed-precondition；缺/壞 repoId →
  invalid-argument；repo 不存在 → not-found；非 owner → permission-denied；成功（webhook 刪、
  recursiveDelete 呼叫、member pointers 刪、回 {}）；webhook 刪除失敗仍成功清 Firestore；
  repo doc 無 webhookId 時跳過 webhook 刪除。
- [ ] GitHub 呼叫全走 githubClient（無散落 Octokit import）。

## Frontend — minimal delete UI（範圍擴充，2026-06-02 使用者要求納入）

後端函式無觸發入口則使用者無法刪除，故加最小可用 UI：

- `RepoListViewModel` 注入 `FunctionsService`，新增 `removeRepo(repoId)`（busy/error 狀態，
  沿用 fake 模式可測）。刪除成功後清單靠既有 `streamReposOfUser` stream 自動更新，不需手動 refresh。
- `RepoListPage` 每個 repo `ListTile` 加一個 trailing 刪除 `IconButton` → `showDialog` 確認框
  （顯示 repo 名 + 警告會刪所有任務/資料）→ 確認後呼叫 `vm.removeRepo`。刪除中顯示 disabled/spinner，
  失敗顯示錯誤（SnackBar 或 inline）。
- 遵守 frontend spec：`Consumer`/`Provider.of(listen:false)`、`if (mounted)` after await、
  Theme 取色、不在 View import repositories。

## Out of Scope

- SignInPage / RepoList 的完整 prototype 視覺還原（模組 A）—— 本任務只加可用的刪除入口，不做美化。
- webhook 事件處理（Sprint 4）。

## Technical Notes

- 對稱參考 `addRepo.ts`（auth → 驗證 → best-effort webhook → 批次寫）。本任務是反向。
- 刪 webhook 需要 owner/admin 權限（與註冊相同）。
