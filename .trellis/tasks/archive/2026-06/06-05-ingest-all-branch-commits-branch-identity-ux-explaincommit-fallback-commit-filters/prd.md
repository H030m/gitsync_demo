# Ingest all-branch commits + branch identity UX + explainCommit fallback + commit filters

## Goal

Round 2 of the Commits intelligence hub, driven by live findings:
the webhook deliberately skips non-default-branch pushes (`githubWebhook.ts:50`,
log: "Skipping push to non-default branch"), so commits pushed to feature
branches never reach Firestore → the list view misses recent work and
`explainCommit` 404s for branch-graph commits. Plus UX upgrades the user asked
for: branch identity on the graph, and a filterable commit list.

## Root causes found (live production debugging)

* Firestore has 37 commit docs, newest 2026-06-02 — every 6/4-6/5 push went to
  `feature/summary-intel-hub` and was skipped by design.
* `explainCommitFlow` throws `not-found` when the commit doc is missing — all
  branch-graph commits not on main have no doc → "AI 功能有問題".
* The list view is a realtime Firestore stream — "no refresh button" was a
  red herring; once ingestion covers all branches it updates live.

## Decisions (ADR-lite)

**D1 — Webhook ingests ALL branches, full enrichment.** (user-confirmed)
Remove the default-branch skip; store a `branch` field (from push `ref`) on
each commit doc. First-seen branch wins: if the doc already exists (same sha
re-pushed via merge to main), do NOT overwrite — preserves the original
feature-branch attribution and avoids re-triggering enrichment.
`onCommitCreated` (AI summary + embedding) runs for every new commit; cost
accepted (≪ free tier at team scale).

**D2 — explainCommit falls back to the GitHub API when the doc is missing.**
Read the caller's `githubAccessToken` (same as getCommitGraph), fetch the
commit (message + files + stats) via a new `githubClient.getCommit` helper,
generate the summary from that context. No cache write on the fallback path
(no doc to cache on). Covers historical/branch commits predating D1.

**D3 — Branch identity on the graph.** (user-confirmed: rail tap, no canvas
hit-testing)
* Stable color per BRANCH (hash/first-seen index of `primaryBranch`), not per
  lane — today the same branch changes color when it switches lanes.
* The lane-assignment pass additionally records, per row, the branch each
  active lane belongs to (resolve a lane's expected sha → that commit's
  primaryBranch).
* Tapping the rail region of a row (the whole fixed-width left strip — a big
  target, no per-pixel hit test) pops up a small sheet/menu listing the lanes
  at that row: color dot + branch name, the tapped commit's own branch first.
* The commit detail sheet also shows the branch name.

**D4 — The author view becomes a filterable commit list.** (user-confirmed)
Replace the per-author lane map with a flat list + filter chip bar:
* **Author** — multi-select from authors present in loaded commits.
* **Branch** — multi-select from `branch` values (post-D1 docs; legacy docs
  without the field group under "main").
* **時段** — the existing date-range picker, integrated into the same bar.
* **Keyword** — client-side substring match on the commit message.
Filters compose (AND across dimensions, OR within a multi-select). Toggle
labels become: 分支圖 / 列表.

**D5 — No Cloud Storage migration.** (user-confirmed after cost estimate)
Commits/Discord stay in Firestore: realtime streams, field queries and vector
search depend on it; team-scale usage is far below the free tier. Future
option if volume ever grows: archive old Discord messages to Storage.

**D6 — Backfill the gap.** One-off script `functions/scripts/backfill-commits.mjs`:
GitHub API (`GITHUB_TOKEN` env) lists commits per branch, writes missing docs
(with `branch`, Timestamp `committedAt`) via admin SDK; idempotent (skip
existing shas), `--dry-run` gated. Run once after deploy.

**D7 — Graph refresh auto-syncs missing commit docs.** (user-confirmed;
supersedes running D6's local script for the 6/3–6/5 gap)
After a non-cached `getCommitGraph` fetch, the flow best-effort writes any
fetched commit that has no Firestore doc, using the SAME shape and
first-seen-wins `create()` semantics as the webhook (`branch` =
`primaryBranch`, `committedAt` = Timestamp from ISO, `url` constructed as
`https://github.com/{owner}/{repo}/commit/{sha}`, empty file arrays — the
GraphQL payload has no file list). Skipped on cache hits; a sync failure
never fails the graph call. Newly created docs trigger `onCommitCreated`
enrichment (accepted one-off cost). In-app effect: tapping the graph
refresh button fills the list view's history gap — no local script needed,
works for future multi-user self-service.

## Acceptance Criteria

* [ ] Pushing to ANY branch creates commit docs (webhook test: non-default ref
  no longer skipped; `branch` field stored; existing doc not overwritten).
* [ ] The list view shows feature-branch commits in realtime after deploy;
  backfill script fills the 6/3–6/5 gap (re-run dry-run reports 0 missing).
* [ ] Tapping a branch-graph commit whose doc is missing still produces an AI
  summary (GitHub fallback; unit test: doc missing + GitHub mock → markdown).
* [ ] Same branch = same color everywhere in the graph; tapping a row's rail
  pops up lane→branch names; detail sheet shows the branch.
* [ ] List filters: author / branch / keyword chips + date range compose
  correctly (widget tests cover at least author+keyword compose case).
* [ ] functions typecheck/lint/tests + flutter analyze/test green.

## Out of Scope

* Cloud Storage migration (D5) / Discord archival.
* Canvas per-pixel line hit-testing (D3 uses the rail-region tap instead).
* Server-side keyword search indexes (keyword filter is client-side).
* Auto-refresh/polling for the branch graph (covered by previous task's
  manual refresh).

## Technical Notes

* Webhook: `functions/src/handlers/githubWebhook.ts` handlePush — remove skip,
  add `branch: ref.replace('refs/heads/','')`, use per-doc existence check or
  `create()` + ignore ALREADY_EXISTS for first-seen-wins semantics (batch.set
  would clobber enriched fields: aiSummary/embedding/linkedTaskIds!).
* GitHub push payload caps `commits[]` at 20 — note in webhook comment;
  backfill/merge flows cover bigger pushes.
* explainCommit handler must now read the user token; keep flow signature
  change additive. All GitHub access stays in githubClient.ts (§6.4).
* Flutter `Commit` model gains `branch` (nullable, legacy docs lack it).
* Graph colors: build branch→color map from `graph.branches` order (stable
  across reloads since branches sorted by recency... use name hash if not).
  Prefer name-hash to keep color stable across refetches.
* Rail tap: wrap the rail `SizedBox` in a `GestureDetector` (separate from the
  row `InkWell`); show a `showModalBottomSheet`/menu with lane entries.
* `dailyIntel` readers unaffected (they query by time range; now include
  branch commits in reports — desirable; note in ARCHITECTURE).
* Docs to update: ARCHITECTURE.md data model (`branch` field), webhook
  decision comment, database-guidelines if any new pattern emerges.
