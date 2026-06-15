# addRepo 重複時加入為 member 而非報錯

## Goal

讓第二位（及之後）隊友貼同一個 GitHub URL 加 repo 時，**加入成為該 repo 的
member**，而不是被 `already-exists` 擋下（目前 `addRepo.ts:119` 直接丟錯，前端把
錯誤字串顯示成「已經加過了」）。repo 的資料模型（`memberIds[]` + `members/` subcollection）
本來就為多人設計。

## What I already know（repo inspection 2026-06-02）

* `functions/src/handlers/addRepo.ts:115-124` — 目前 step 3：`repoRef` 存在就
  `throw HttpsError('already-exists', ...)`。這是唯一要改的地方。
* step 1-2 已驗證：caller 有 githubAccessToken、`verifyRepoAccess` 確認 caller 對該
  repo 有 `permissions.admin || permissions.push`。**這層權限檢查在加入路徑要保留**（決策）。
* step 5 建立三份 doc 的寫法可參考：`repos/{repoId}`、`users/{uid}/repos/{repoId}`、
  `repos/{repoId}/members/{uid}`。新建立時加入者 role=`owner`。
* 前端 `lib/views/repos/add_repo_page.dart:32-34` — `addRepo` 成功回 `{repoId}` →
  直接 `goTasks(repoId)`；失敗 `e.toString()` 顯示。**前端不需改**：加入者成功後一樣進任務頁。
* `repos/{repoId}.memberIds` 是陣列 → 用 `FieldValue.arrayUnion(uid)` 加入。

## Decisions

* **[權限]** 加入仍要求 caller 對該 GitHub repo 有 `push || admin`（與建立者一致；維持 step 2 檢查）。
* **[角色]** 新建立 repo 的人 = `owner`；後續加入者 = `member`。
* **[已是 member]** caller 已在 `members/{uid}` → 不丟錯，idempotent 直接回 `{repoId}`（前端進該 repo）。
* **[不碰既有設定]** 加入路徑**不**重新註冊 webhook、不覆蓋 `webhookSecret` / `createdBy` /
  既有欄位 —— 只新增該 member 的 doc + arrayUnion。

## Requirements (final)

step 3 改為：讀 `repoRef`。
* **不存在** → 照舊：註冊 webhook（best-effort）+ batch 寫三份 doc（role `owner`）+ 回 `{repoId}`。
* **存在** → 進「加入」分支（**跳過 webhook 註冊**）：
  * 先讀 `members/{uid}`；已存在 → 直接回 `{repoId, joined:false}`（或等價 idempotent）。
  * 不存在 → 在一個 batch 內：
    * `set members/{uid}` = `{ role:'member', activeIssueCount:0, completedTaskCount:0, lastActiveAt: serverTimestamp() }`
    * `set users/{uid}/repos/{repoId}` = `{ role:'member' }`
    * `update repos/{repoId}` = `{ memberIds: FieldValue.arrayUnion(uid) }`
  * 回 `{repoId}`。
* 權限/token 驗證（step 1-2）**在兩條路徑都先跑**（加入者也要證明對 repo 有 push/admin）。

## Acceptance Criteria (final)

* [ ] repo 不存在 → 行為與現狀完全相同（owner + webhook + 三份 doc）。
* [ ] repo 存在 + caller 非 member + 有 push/admin → 加入為 `member`（三處寫入正確），回 `{repoId}`，不再丟 already-exists。
* [ ] repo 存在 + caller 已是 member → idempotent 回成功，不重複寫、不丟錯。
* [ ] repo 存在 + caller **無** push/admin → 仍擋下（沿用 step 2 的 failed-precondition）。
* [ ] 加入路徑不重新註冊 webhook、不動既有 repo 欄位。
* [ ] 單元測試（boundary-mock GitHub + Firestore）涵蓋上述每條。
* [ ] lint / typecheck / 既有測試全綠。

## Definition of Done

* Tests added；lint / typecheck / jest green。
* 行為若值得記錄 → 更新 spec。

## Out of Scope

* 前端改動（成功路徑已支援）。
* 邀請/審核流程、移除 member（另議）。
* 角色權限細分（admin vs member 能做什麼）。

## Technical Notes

* `memberIds` 用 `arrayUnion` 確保併發/重入安全。
* 加入分支跳過 webhook：webhook 在第一次建立時已註冊，重複註冊會多餘且可能失敗。
