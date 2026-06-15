# 任務完成自動分派下游 + FCM 通知（實作 onTaskUpdated）

## Goal

實作 `functions/src/triggers/onTaskUpdated.ts`（目前是 stub）：當一個 task 的
`status` 變成 `done` 時，找出被它擋住、現在可以開始的**下游任務**，自動呼叫
`assignTaskFlow` 分派出去，並對**新接手的 assignee** 發 FCM 推播通知。對應
ARCHITECTURE §4.3 onTaskUpdated 的 TODO a/b。

## What I already know（repo inspection 2026-06-02）

* `functions/src/triggers/onTaskUpdated.ts` — ✅ 已是 `onDocumentUpdated` on
  `apps/gitsync/repos/{repoId}/tasks/{taskId}`，已 `markIdempotent(event.id)`，
  body 只有 log（stub）。TODO 列了 a 查下游 / b 發 FCM / c Discord / d handoff。
* **重用 `assignTaskFlow`**（剛完成）：auto-apply 設計會寫 `assigneeId` + 平衡
  `activeIssueCount`（`applyAssignment`，txn + increment）。下游分派直接呼叫它即可。
* `markTaskDone`（tools/taskStatus.ts）已處理「**完成的那個 task**」的 counter
  （assignee `completedTaskCount +1` / `activeIssueCount -1`）→ 本 trigger **不要**
  再動完成任務的 counter，避免重複算。
* FCM：`getMessaging().send({ token, notification:{title,body} })`（參考
  `handlers/subscribeToTopic.ts`）。token 在 `apps/gitsync/users/{userId}.fcmToken`。
* task 欄位：`status('todo'|'in_progress'|'done')`、`assigneeId?`、`dependsOn: string[]`。
* 下游查詢：`tasks where dependsOn array-contains <completedTaskId>`（單欄 array-contains，
  Firestore 自動索引，免建 composite）。

## Design（初稿，brainstorm 收斂）

```
onTaskUpdated 觸發（task A 被 update）
  ├─ markIdempotent(event.id)（已有）
  ├─ guard: before.status !== 'done' && after.status === 'done'  ← 只在「轉成 done」時動作
  │     （assignTaskFlow 之後會寫下游的 assigneeId → 再觸發本 trigger，但下游 status 沒變 → guard 擋掉，不遞迴）
  ├─ 查下游 B = tasks where dependsOn array-contains A.id
  ├─ 對每個 B：判斷是否「可分派」（見 Q1）→ 呼叫 assignTaskFlow({repoId, taskId:B})
  └─ 對 B 新分到的 assignee 發 FCM（讀 users/{assigneeId}.fcmToken）
```

部署注意：本 trigger 會呼叫 `assignTaskFlow`（用 OpenAI）→ `onTaskUpdated` 要掛
`secrets:[openaiKey]`、並調高 `timeoutSeconds`（多個下游 × 每個 agentic loop）。

## Decisions

* **[Q1 → 全部前置 done]** 只有當 B 的 `dependsOn` 裡**每一個**前置任務都 `status==='done'`
  時才分派 B。實作：查到下游 B 後，讀 B 的所有 `dependsOn` 任務狀態，全 done 才繼續。
  （A 剛轉 done，所以至少 A 滿足；其餘前置要另外確認。）

* **[Q3 → 跳過不重分，但仍通知]** B 已有 `assigneeId` → 不呼叫 assignTaskFlow（不覆蓋手動指派、省 OpenAI）。
  但只要 B 這次變成 ready，**仍對 B 的（既有或新分派）assignee 發一次 FCM**「可以開始了」。
  即：notify 的對象 = 任何「這次變 ready 的下游」的 assignee，不論是剛分派還是原本就有。
* **[Q2 → 是，聚焦]** 本 task 只做「自動分派 + FCM 通知」。Discord 通知 / generateHandoff
  （onTaskUpdated TODO c/d）留給之後各自的 task。
* **[Q4 → best-effort]** 逐一處理下游；某個 B 失敗（OpenAI / 無 member / 無 token）只 log，
  繼續處理其他 B，不讓整個 trigger 失敗。

## Open Questions

（無 — 需求已收斂）

## Requirements (final)

* **Transition guard**：只在 `before.status !== 'done' && after.status === 'done'` 時動作；
  其餘 update（含 assignTaskFlow 寫下游 assigneeId）直接 return → 不遞迴。
* **查下游**：`tasks where dependsOn array-contains <completedTaskId>`。
* **Ready 過濾**：對每個下游 B，讀其所有 `dependsOn` 任務，**全部 done** 才算 ready；否則略過。
* **分派**：ready 且 `!B.assigneeId` → 呼叫 `assignTaskFlow({repoId, taskId:B})`（重用，counter 由它處理）；
  ready 且已有 assignee → 跳過分派。
* **通知**：對每個「這次變 ready」的 B，讀 `users/{B.assigneeId}.fcmToken`，
  `getMessaging().send({token, notification})` 通知該 assignee。無 token → 略過。best-effort。
* **不重做 counter**：完成任務的 counter 由 `markTaskDone` 處理；下游分派 counter 由 `applyAssignment` 處理。
* **部署**：`onTaskUpdated` 加 `secrets:[openaiKey]`、調高 `timeoutSeconds`（多下游 × agentic loop）。

## Acceptance Criteria (final)

* [ ] A 轉 done → 全前置皆 done 的下游 B，若未指派則被 assignTaskFlow 分派、`B.assigneeId` 寫入。
* [ ] 每個變 ready 的 B 的 assignee（新或舊）收到一次 FCM（有 fcmToken 時）。
* [ ] 前置未全 done 的下游不被分派/通知。
* [ ] 非「轉 done」的 update 不觸發任何動作（不遞迴）；counter 不重複計算。
* [ ] 單一 B 失敗不影響其他 B（best-effort）。
* [ ] 單元測試（boundary-mock OpenAI / Firestore / messaging）涵蓋上述每條。

## Definition of Done

* Tests added；lint / typecheck / jest green。
* schema/行為若有新慣例 → 更新 spec。

## Out of Scope

* Discord 通知 / `generateHandoffFlow`（onTaskUpdated TODO c/d，各自獨立 task）。
* 前端通知 UI / FCM 前端接收設定（假設已另行處理）。

## Technical Notes

* `onTaskUpdated` 改掛 `secrets:[openaiKey]` + 調 timeout；沿用既有 markIdempotent。
* FCM best-effort：發送失敗只 log，不影響分派結果（Rule D 精神：慢/外部呼叫不卡主邏輯）。
