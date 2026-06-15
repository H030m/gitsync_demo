# Fix commit range query + contributions names + real branch graph

## Goal

Three user-facing fixes on the Summary/Commits intelligence hub:

1. **Range filter shows zero commits** — legacy Firestore commit docs have string-typed
   `committedAt`, which silently falls out of every Timestamp range query
   (`streamRange`, `dailyIntel.listRangeCommits`). Run the existing
   `functions/scripts/normalize-commits.mjs` migration against production and verify the
   fixed webhook (7144b4b) is actually deployed.
2. **Contributions chips show Firebase UIDs** — `computeContributions` keys by `userId`
   (per ARCHITECTURE.md data model); the Flutter `_ContributionsCard` renders the raw key.
   Show GitHub usernames (or display names) instead.
3. **Real branch graph** — replace/extend the current per-author "commit tree map" with an
   actual git graph: branches as lanes, showing where a branch forked and when it merged.

## What I already know

* `commit_repo.dart:57-71` `streamRange` compares `committedAt` against `Timestamp` —
  string-typed docs never match. `streamRecent` (orderBy only) still returns them, which
  is why the default view works but any picked range is empty.
* Once a range is picked, the only way back to "Recent 50" is the X (clear) button —
  re-picking the same dates stays on the (broken) range query. (`commits_vm.dart`)
* `normalize-commits.mjs` (string → Timestamp, filesChanged count → list) already exists
  but has not been run against production data.
* Webhook fix (7144b4b) writes `committedAt` as Timestamp going forward — need to confirm
  it is deployed to the live Functions environment.
* `computeContributions` (`functions/src/tools/dailyIntel.ts:358`) maps
  `author.login → userId` via roster; unmatched commits keep their login. Frontend
  `_ContributionsCard` (`daily_view_page.dart:438,447`) renders `e.key` raw → members
  with a linked GitHub account ironically show as UIDs.
* Current `_CommitTree` (`daily_view_page.dart:977+`) assigns lanes **per author**, not
  per branch. It is a flattened list with day headers, painted rails, tap-to-explain.
* **Data gap for a real git graph**: commit docs store no `parents` and no `branch`.
  The GitHub push webhook payload does NOT include parent SHAs (only id/message/
  timestamp/author/added/removed/modified + top-level `ref` for the branch). Parent SHAs
  require the GitHub REST API (`repos.listCommits` / `repos.getCommit` return `parents`).
  `githubClient.ts` already wraps Octokit (`getRecentCommits` exists but does not map
  parents).

## Assumptions (temporary)

* Production Firestore still contains string-typed `committedAt` docs (matches observed
  symptom).
* A user access token usable for GitHub API enrichment is available server-side (same
  mechanism used by `createIssue`/`verifyRepoAccess`).

## Open Questions


## Decision (ADR-lite)

**D1 — Branch-graph data source: on-demand Cloud Function.**
Context: push webhook payload has no parent SHAs; a real git graph needs them.
Decision: new callable `getCommitGraph(repoId, range)` fetches branches + commits (with
`parents[]`) live from the GitHub API inside Functions and returns assembled graph data;
short-term caching allowed. No Firestore schema change, no backfill.
Consequences: graph view has per-open API latency and needs the network; existing commit
docs work without migration; all GitHub access stays in `githubClient.ts` (§6.4).

**D2 — UI: two switchable views on the Commits tab.**
Decision: add a toggle (branch view / author view). The existing per-author tree map
stays; the new branch graph is a sibling visualization. Both keep tap-to-explain and the
shared range filter.
Consequences: two painting code paths to maintain; toggle state lives in the
CommitsViewModel (or local widget state).

**D3 — Contributions naming: backend writes names into the report.**
Decision: `summarizeDay` resolves userId → githubLogin/displayName from the roster at
report-generation time and persists them alongside the tallies (e.g.
`memberContributions[key] = { tasksDone, commits, githubLogin, displayName }` or a
sibling `membersMeta` map). Flutter renders the stored name, falling back to the raw key.
Consequences: zero extra client reads; schema addition to the report doc (update
ARCHITECTURE.md data model); reports generated before this change still show UIDs until
regenerated — the frontend fallback keeps them rendering.

**D4 — Ops: migration + deploy run from this machine, dry-run gated.**
Decision: run `node scripts/normalize-commits.mjs --dry-run` first, show the scan result
to the user, then run for real and `firebase deploy --only functions` after confirmation.
Requires gcloud ADC / GOOGLE_APPLICATION_CREDENTIALS and a logged-in firebase CLI; if
missing, prompt the user to run `! gcloud auth application-default login`.

## Requirements

1. **Range filter works**: range-filtered commit queries return the same commits visible
   in "Recent 50" when the range covers them (production data normalized + fixed webhook
   deployed).
2. **Contributions names**: report docs carry githubLogin/displayName per member;
   chips render names (fallback: raw key for legacy reports).
3. **Branch graph**: new `getCommitGraph` callable (GitHub API, parents included) + a
   branch-topology view on the Commits tab, toggleable with the existing per-author tree
   map. Shows fork points, merge edges, lane per branch, time-ordered; tap-to-explain
   retained on both views.
4. **Date picker UX**: an obvious "Recent 50" reset affordance in the filter row (not
   just the small X); empty-state copy points to it.
5. **Graph niceties**: author avatar/name on graph nodes (GitHub `author.avatar_url`);
   merge commits labeled with their PR number (via commit message `#N` /
   `pullRequests` collection).

## Acceptance Criteria

* [ ] Picking a date range that contains known commits shows those commits.
* [ ] `normalize-commits.mjs` run on production: 0 string-typed `committedAt` remain;
  deployed webhook writes Timestamp.
* [ ] Contributions card shows GitHub usernames for roster-matched members on newly
  generated reports; legacy reports still render (fallback).
* [ ] Branch graph shows: lane per branch, fork edge, merge edge, commit dots in time
  order, author avatars, PR number on merge nodes; tapping a commit opens the AI
  explanation.
* [ ] Toggle switches between branch view and author view; range filter applies to both.
* [ ] "Recent 50" reset is reachable in one tap from the filter row and from the empty
  state.
* [ ] GitHub API failure (rate limit / missing token) shows an error state with retry,
  not a spinner or crash.

## Definition of Done (team quality bar)

* Tests added/updated (functions vitest + flutter test where appropriate)
* Lint / typecheck / CI green
* Docs updated if schema changes (ARCHITECTURE.md data model section)
* Migration is idempotent and dry-runnable

## Implementation Plan (ordered)

1. **Ops**: dry-run + real run of `normalize-commits.mjs`; `firebase deploy --only
   functions`. Verify range filter live.
2. **Contributions names**: backend enrichment + tests → Flutter model/card + fallback →
   ARCHITECTURE.md.
3. **getCommitGraph backend**: githubClient GraphQL fn + flow + handler + cache + vitest.
4. **Branch-graph frontend**: FunctionsService method → VM toggle/state → lane algorithm
   (pure Dart, unit-tested) → painter widget + avatars + PR badges → wire tap-to-explain.
5. **Picker UX**: Recent-50 reset affordance + empty-state copy.
6. **Quality**: lint/typecheck/tests both stacks; update docs.

## Out of Scope (explicit)

* Branch filtering / zoom-pan on the graph (future evolution).
* Showing commits only reachable from deleted branches — inherent limitation of the
  on-demand approach (GitHub API walks from current branch heads). Documented, not
  worked around.
* Backfilling parents/branch into Firestore commit docs (D1 chose on-demand).
* Regenerating historical reports to fix their UID keys (frontend fallback covers them).

## Research References

* [`research/flutter-git-graph-rendering.md`](research/flutter-git-graph-rendering.md) —
  keep ListView.builder + per-row CustomPaint (no new package); standard active-lanes
  algorithm with above/below lane snapshots per row for fork/merge diagonals.
* [`research/github-api-commit-graph.md`](research/github-api-commit-graph.md) — single
  GraphQL query (refs first:20 → history(since,until) with parents/avatar/
  associatedPullRequests), ~90s-TTL Firestore cache, callable mirrors the explainCommit
  handler+flow pattern, user OAuth token from users/{uid}.githubAccessToken.

## Technical Approach

* **Part 1 (data fix, ops)**: `node scripts/normalize-commits.mjs --dry-run` → confirm →
  real run → `firebase deploy --only functions` (verifies 7144b4b webhook is live).
* **Part 2 (contributions names)**: `computeContributions` (dailyIntel.ts) resolves
  userId → { githubLogin, displayName } from the roster it already loads; report doc
  stores the enriched shape; Flutter `DailyReport` model + `_ContributionsCard` render
  name with raw-key fallback; ARCHITECTURE.md data model updated.
* **Part 3 (branch graph)**:
  * Backend: `getCommitGraph` callable (handler + flow, like explainCommit) → one
    GraphQL query via the user's OAuth token → dedupe commits across branches, attribute
    primary branch, detect merge PR # (parents>=2 + message regex +
    associatedPullRequests) → `{ commits[], branches[] }`; short-TTL cache doc.
  * Frontend: `FunctionsService.getCommitGraph`; CommitsViewModel gains a view toggle
    (branch/author) + graph fetch state; new branch-graph widget reusing the
    ListView + per-row CustomPaint pattern with active-lanes assignment; nodes show
    avatar + name, merge nodes show PR #; tap-to-explain shared with the author view;
    error state with retry (no eternal spinner).
* **Part 4 (picker UX)**: "Recent 50" reset as a visible chip/button in the filter row;
  empty-state copy points to it.

## Technical Notes

* Files inspected: `lib/view_models/commits_vm.dart`, `lib/repositories/commit_repo.dart`,
  `lib/models/commit.dart`, `lib/views/daily/daily_view_page.dart` (_ContributionsCard,
  _CommitTree), `functions/src/handlers/githubWebhook.ts`,
  `functions/src/tools/dailyIntel.ts` (computeContributions),
  `functions/src/flows/summarizeDay.ts`, `functions/src/services/githubClient.ts`,
  `functions/scripts/normalize-commits.mjs`, `docs/ARCHITECTURE.md`.
* GitHub push payload: commits carry no `parents`; branch only via top-level `ref`.
* Graph rendering in Flutter: no obvious off-the-shelf git-graph widget — likely
  CustomPainter + lane-assignment algorithm (research topic).
