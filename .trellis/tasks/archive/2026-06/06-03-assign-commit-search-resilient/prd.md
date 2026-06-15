# searchMemberCommits best-effort + 修 commits 向量索引 scope

## Goal

讓 `assignTaskFlow` 在「commits 向量索引未建 / repo 沒有任何 commit」時**仍能完成分派**，
不要因為一個選用訊號（commit 語意搜尋）整條 throw。並修正 `firestore.indexes.json` 裡
commits 向量索引的 scope（目前是 COLLECTION_GROUP，但 query 是 COLLECTION → 部署了也對不上）。

## 背景（live 診斷 2026-06-02，log 實證）

`onTaskUpdated` 自動分派下游時，`assignTaskFlow` 跑進 `searchMemberCommits` →
`findNearest` 丟 `9 FAILED_PRECONDITION: Missing vector index configuration` →
整個分派失敗 → 下游 `assigneeId` 永遠 null。根因：

* `functions/src/tools/assignTools.ts` 的 `searchMemberCommits` 用
  `.collection('apps/gitsync/repos/${repoId}/commits')...findNearest(...)` →
  query scope = **COLLECTION**。
* `firestore.indexes.json` 兩個 commits 向量索引卻是 `"queryScope": "COLLECTION_GROUP"`
  → 即使 `firebase deploy --only firestore:indexes` 也建錯 scope，query 仍說「缺索引」。
* 設計脆弱點：commit 搜尋只是分派的其中一個訊號（負載 / 專長 / 下游 是另外三個），
  但它一 throw 就害整條分派死。demo 用乾淨 repo（無 commit）會每次踩到。

## Decisions

* **[主修]** `searchMemberCommits` 包 try/catch：`findNearest` 或任何查詢失敗 → log warn 後
  回 `[]`（best-effort，Rule D 精神：選用的慢/外部訊號失敗不可拖垮主流程）。既有「無 githubLogin /
  無 commit → 回 []」行為保留。
* **[索引]** 把 `firestore.indexes.json` 兩個 `commits` 向量索引 `queryScope` 由
  `COLLECTION_GROUP` 改為 `COLLECTION`（對齊 `.collection()` query）。`discordMessages` 向量索引
  若其消費端也是 `.collection()` 查詢，一併改 COLLECTION（順手對齊；若無消費端則保持不動，註明）。
* **[不改] ** 不改分派邏輯本身、不改 query 的 prefilter（`repoId` + `author.login` 仍保留）。

## Requirements (final)

* `searchMemberCommits` 的 `findNearest` 區段以 try/catch 包住；catch → `logger.warn`（含 repoId、
  memberId、err）後 `return []`。函式對外行為：永不 throw，最差回 `[]`。
* `firestore.indexes.json`：commits 兩個向量索引 → `queryScope: "COLLECTION"`。
* 給使用者一條可直接跑的部署字串（`firebase deploy --only firestore:indexes`，或 log 提供的
  gcloud `--query-scope=COLLECTION` 版本當 fallback）。AI 不自行部署（AI_AGENT_RULES §R1/R2）。

## Acceptance Criteria (final)

* [ ] `searchMemberCommits` 在 `findNearest` 丟錯（含 FAILED_PRECONDITION 缺索引）時回 `[]`、不 throw。
* [ ] `assignTaskFlow` 在「commit 搜尋失敗 / repo 無 commit」時仍正常 finalize 分派（用負載/專長/下游）。
* [ ] `firestore.indexes.json` commits 向量索引 scope = COLLECTION。
* [ ] 單元測試：mock `findNearest` throw → `searchMemberCommits` 回 []；assignTaskFlow 端到端仍分派成功。
* [ ] lint / typecheck / 既有測試全綠。

## Definition of Done

* Tests added；lint / typecheck / jest green。
* 沉澱：選用外部訊號 tool 要 best-effort（更新 spec 視情況）。

## Out of Scope

* 改分派演算法 / prompt。
* Discord handoff 的 searchDiscordMessages 行為（除非順手改 index scope）。
* 實際部署索引（使用者執行）。

## Technical Notes

* best-effort 後，demo **不需要** commit 向量索引就能跑動態分派；索引只是讓 commit 訊號生效的加分項。
* 之前 spec 已有 Rule D（慢/外部呼叫不進關鍵路徑）—— 這裡是同精神套到「選用 tool 失敗」。
