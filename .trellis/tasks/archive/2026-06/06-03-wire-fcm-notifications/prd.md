# 接上 FCM 通知：initialize 接線 + web service worker/VAPID

> **狀態：TODO（planning，尚未啟動）**。記錄於 2026-06-03，動態分派 live 驗證時發現
> 通知收不到。動態分派本身已可運作，這是錦上添花的後續工作。

## Goal

讓 `onTaskUpdated` 自動分派下游後，被指派的 member 真的**收到 FCM 推播通知**。
目前後端已會發（`tools/notify.ts` `notifyAssignee`），但 log 一直是
`notifyAssignee: no fcmToken, skipping` —— 因為 `users/{uid}.fcmToken` 從來沒被寫進去。

## 診斷（已查證，repo inspection 2026-06-03）

**根因（與平台無關）：`PushMessagingService.initialize()` 從沒被呼叫。**
* `lib/services/push_messaging.dart` — `initialize({userId})` 會 `requestPermission` →
  `getToken()` → `userRepository.updateFcmToken(uid, token)`，邏輯完整。
* 但 `lib/main.dart:44` 只把它註冊成 `Provider<PushMessagingService>(create:...)`，
  **全專案沒有任何地方 call `.initialize(userId:...)`** → token 永遠沒被取得/寫入。
* ⇒ 即使在手機上跑也收不到通知，不是只有 web。

**Web 額外門檻（即使 initialize 接好）：**
* `web/` 沒有 `firebase-messaging-sw.js`（FCM web 必須的 service worker）。
* `push_messaging.dart:38` 的 `getToken()` 沒帶 `vapidKey` —— web 取 token 必填，
  要去 Firebase Console → Cloud Messaging → Web Push certificates 拿 VAPID key。
* 需 HTTPS + 瀏覽器通知權限。

## 待釐清（啟動前 brainstorm）

* [平台] demo 通知要跑手機、web、還是兩者？（決定要不要做 web service worker/VAPID）
* [替代方案] 是否改用 **app 內 Firestore 監聽「assigneeId == 我」→ 跳 in-app 提示**，
  完全不碰 FCM/web sw？對 demo 可能更穩、更省事。值得跟推播二選一或併行評估。

## 可能的 Requirements（待 brainstorm 收斂）

* 共通：登入成功後呼叫 `PushMessagingService.initialize(uid)`（補上漏掉的接線）；
  處理權限被拒的情況。
* Web（若需要）：加 `web/firebase-messaging-sw.js`、`getToken(vapidKey: <key>)`。
* 前端 foreground / tap 行為目前是 `debugPrint` placeholder → 視需要補成 in-app banner + 導頁。

## Out of Scope（本 TODO 不含、已完成）

* 後端發送邏輯（`notifyAssignee` 已實作且運作中）。
* 動態分派本身（`onTaskUpdated` + `assignTaskFlow` 已 live 驗證成功）。

## Technical Notes

* 後端只認 `users/{uid}.fcmToken`；只要前端把 token 寫進去，現有發送就會生效。
* 課程限制：FCM 屬 Firebase、可用；web 設定較繁，手機最單純（見團隊記憶 final-demo 限制）。

## 2026-06-10 進度更新（嘉駿，分支 `feature/foreground-notifications`）

部分完成 —— **前景顯示 + demo 觸發** 那一塊：

* `initialize(userId)` 的接線 **早已補上**（`sign_in_page.dart` 登入成功後就 call），所以 token
  寫入這條已通，非本次工作。
* 本次補的是 PRD「待釐清/Requirements」裡的 **foreground 行為**：`onMessage` 不再只是
  `debugPrint`，改用新的 `LocalNotificationsService`（`flutter_local_notifications`）在 app 前景
  也彈出可見的系統通知（Android 前景不會自動顯示 FCM notification message）。
* 加 **Settings →「傳送測試通知」** 作為 demo 觸發點，不必等後端真的發 FCM。
* Android build 需 core library desugaring（`flutter_local_notifications` 用 `java.time`）。

**仍未做（維持 out of scope）**：

* Web push（`web/firebase-messaging-sw.js` + `getToken(vapidKey:)`）—— demo 走手機，不做 web。
* 通知點擊深連結目前只導到 `/notify`（FCM 背景點擊的 `repoId+taskId` 深連結邏輯沿用既有）。

→ 平台已收斂為「手機」，原 PRD 的 web 分支可在 demo 後再評估是否需要。

## 2026-06-10 接手（廷煥 / smartalan91）

嘉駿同意把此 task 交給廷煥接續。接手時的狀態：

* 分支 `feature/foreground-notifications`（4 commits，尚未併回 develop）。
* 嘉駿口頭回報「跑起來是錯的」—— 具體症狀**待釐清**（journal 只寫到「尚未在裝置端實測」）。
* develop 已前進（7 個 UI redesign commits 移入，含 `settings_page.dart` 大改），
  本分支的 Settings 測試按鈕改動**預期會與 develop 衝突**，併回前需處理。

## 症狀（已確認，2026-06-10）

* **(a) Settings「傳送測試通知」按了沒彈**（嘉駿口頭回報）。
* **重現結果（廷煥，2026-06-10）：在乾淨環境重現不出來——測試通知正常彈出。**
  環境：AVD Medium_Phone_API_36.1（Android 16）、fake mode、cold install（非 hot reload）。
* 推論：code 本身可運作。嘉駿端的「沒彈」較可能是環境因素：
  (1) hot reload 進已在跑的 app → 新 plugin 未註冊（journal 寫他「尚未在裝置端
  hot-restart 實測」，與此吻合）；(2) 該裝置先前拒絕過通知權限 → `show()` 靜默失敗。
* **既有 UX 缺陷**：權限被拒時按按鈕完全沒有回饋（靜默失敗）——這正是「按了沒彈」
  難以自我診斷的原因，列入本 task 修補範圍（見 Requirements）。
* **缺陷已實測證實（廷煥，2026-06-10）**：在模擬器上拒絕通知權限後重進 app，
  按「傳送測試通知」確實完全無反應。修法：按下時檢查權限 → 未授權先 re-prompt →
  仍被拒則 SnackBar 提示去系統設定開啟（不引入新套件）。

## Open Questions（接手後待釐清）

* [環境] 廷煥本機尚無 Android emulator —— 重現前要先建一台 AVD。
* [環境] live 端到端實測（後端真發 FCM）前需：加入 Firebase 專案、`flutterfire configure`、
  登記 debug SHA（Console 操作由本人親跑）。

## 接手後的 Acceptance Criteria

* [x] Settings「傳送測試通知」在 Android 裝置/模擬器上確實彈出系統通知（2026-06-10 廷煥實測）
* [x] 權限被拒時按測試通知有明確回饋（SnackBar 提示開啟通知；2026-06-10 廷煥實測）
* [x] 後端 `notifyAssignee` 真發的 FCM：app 前景重畫為可見通知 ✓、背景收到系統推播 ✓
  （2026-06-12 廷煥 live e2e：done→auto-notify 下游 assignee，繁中標題「有新任務可以開始了」
  證實 per-locale push 也生效；log 證據 `[FCM foreground]` / `[FCM background]`）
* [x] 點擊通知導向正確頁面（2026-06-12 實測）
* [x] `flutter analyze` 0 error/0 warning、`flutter test` 79/79（2026-06-10）
* [x] 與 develop 合併乾淨（實際無衝突）→ PR #38 開出後**經隊友同意直接併入 main**
  （2026-06-12；偏離 git-workflow 的 develop-first 慣例，屬團隊當下決定）
  ⚠️ 後續：develop 尚未包含本工作，main/develop 已分岔（9 vs 7 commits）——
  待 owner（嘉駿）把 main back-merge 回 develop

> e2e 環境備註：模擬器 DNS 兩度抽風（`Failed to resolve name` 連發、Firestore 斷流）——
> 冷重啟 emulator（`-no-snapshot-load -dns-server 8.8.8.8`）可解；FCM 走 GMS 通道不受影響。
> 另記：Daily 頁 `summarizeDay` callable 回 `[firebase_functions/internal]`（後端既有問題，
> 與本 task 無關，待轉告 owner）。
