# PR triage — workload-aware reviewer recommendation (A+D)

## Goal

Fix the Matthew effect in `flows/triagePr.ts:pickReviewers`. Today
`activeIssueCount` is only a tiebreak; since file-history scores almost never
tie (sums of `1/(rank+1)`), workload is effectively ignored and the top
maintainer gets piled onto. Move workload into the **primary** score and add
freshness rotation for slot 2.

## What I already know (from repo inspection, 2026-06-13)

* All the changes live in **one function**:
  `functions/src/flows/triagePr.ts:pickReviewers` (lines ~129–171).
* Inputs to the change:
  * Current `tallyCommittersByPath()` output (`scoreByLogin: Map<lower(login), number>`).
  * `readTeamState(repoId)` — already returns `activeIssueCount` per member.
  * **New**: a Firestore range query
    `apps/gitsync/repos/{repoId}/pullRequests where triagedAt != null order by
    triagedAt desc limit 50` → reduce to per-userId pick count over the last
    14 days. Index already implied by existing ordered queries (verify).
* No webhook / trigger / schema changes required. One new helper, one rewrite
  of `pickReviewers`, one optional doc field for observability.
* No new types of dependency — all queries go through the existing `db` import.

## Decisions (locked 2026-06-13)

* **Score blend (A — multiplicative penalty)**:
  `finalScore = fileHistoryScore × loadPenalty(load)`
  `loadPenalty(load) = 1 / (1 + λ × load)` with **λ = 0.3** (hard-coded
  constant for MVP; tunable from one place).
* **What counts as `load`**: weighted blend
  `load = recentTriagePicks(14d) + 0.25 × activeIssueCount`.
  Rationale: recent triage picks is the direct signal (this feature's own
  output); `activeIssueCount` adds context for task assignments. Coefficients
  hard-coded.
* **Top-1 (expert)**: highest `finalScore`, PR author excluded, off-roster
  logins dropped.
* **Top-2 (apprentice — D)**: highest `finalScore` from candidates that are
  **not in `recommendedReviewers` of the last 5 triaged PRs in this repo**.
  Falls back to the highest remaining `finalScore` candidate if the freshness
  filter empties the pool.
* **Slot-2 quality floor**: only fill slot 2 if its candidate's raw
  `fileHistoryScore ≥ 0.5` (i.e. at least one rank-0 commit on one of the
  changed files, OR equivalent rank-1 hits). Below the floor: return 1
  reviewer, not 2. Better fewer-but-correct than rubber-stamping.
* **Observability (safety guardrail #2)**: persist a per-pick breakdown on the
  doc so future-you can tune λ from real data without rerunning.
  ```
  recommendedReviewerScores: [
    { userId, rawScore, load, loadPenalty, finalScore, slot: 1 | 2 }
  ]
  ```
* **Window for "recent triage history"**: **14 days**, capped at the most
  recent 50 PRs whichever comes first. One Firestore query per PR, ~50 docs,
  cheap.
* **Window for "freshness filter"**: **last 5 triaged PRs** (a subset of the
  same query result — no extra read).
* **No new schema for members**. The roster + the existing pullRequests
  collection give us everything.

## Requirements

* New helper in `flows/triagePr.ts` (or a small `tools/` module if it grows):
  `recentTriageLoad(repoId): Promise<{ picksByUserId: Map<string, number>;
  recentReviewerSets: Set<string>[] }>`.
  * `picksByUserId` — total picks per userId in the last 14d / 50 PRs.
  * `recentReviewerSets` — the `recommendedReviewers` arrays of the last 5
    triaged PRs, each as a Set<userId>.
* Rewrite `pickReviewers` to:
  1. Compute `finalScore` per roster candidate.
  2. Sort by `finalScore` desc.
  3. Slot 1 = the head.
  4. Slot 2 = first remaining candidate not in `union(recentReviewerSets)`;
     fall back to next remaining; respect quality floor.
* Return value: existing `RecommendedReviewer[]` plus an internal
  per-pick scores array for the trigger to persist.
* Persist `recommendedReviewerScores` on the pullRequests doc next to the
  existing fields (one extra `set({merge:true})` field — no schema migration).
* Constants live at the top of `triagePr.ts` with named comments:
  `LOAD_LAMBDA`, `ACTIVE_ISSUE_LOAD_WEIGHT`, `LOAD_WINDOW_DAYS`,
  `LOAD_RECENT_PR_CAP`, `FRESHNESS_WINDOW_PRS`, `SLOT_2_SCORE_FLOOR`.

## Acceptance Criteria

* [ ] Unit tests (extend `__tests__/triagePr.test.ts`):
  - [ ] Two candidates with identical `fileHistoryScore` but different recent
        triage loads → lower-load wins primary pick.
  - [ ] One strong-but-busy candidate vs. one weak-but-idle: strong still wins
        when fileHistoryScore gap × penalty math says so (numeric assertion).
  - [ ] Freshness rule on slot 2: top-1 expert, top-2 is the highest-score
        candidate not appearing in any of the synthetic "last 5 PRs"
        reviewer sets.
  - [ ] Slot-2 floor: when only one above-floor candidate exists, return 1
        reviewer, not 2 — never a rubber-stamp pick.
  - [ ] `recentTriageLoad` ignores PRs older than the 14d window AND obeys the
        50-PR cap.
  - [ ] Empty history (new repo) → behaves exactly like the current
        non-load-aware code path.
* [ ] Existing 39 triage tests still pass unchanged in behavior.
* [ ] Trigger test (`__tests__/onPullRequestOpened.test.ts`) extended to
      assert `recommendedReviewerScores` is persisted alongside the other
      triage fields.
* [ ] `npm run typecheck`, `npm run lint`, full `npm test` green.

## Definition of Done

* All AC items pass.
* No schema migration needed (only additive doc fields on new triages).
* Constants documented inline. λ and the load-weight coefficient are
  one-line edits to retune.
* No other flow / handler / trigger touched.

## Out of Scope (explicit)

* Configurable tuning per-repo (λ as a Firestore-settable knob). MVP keeps
  constants in code; if we want UI control later, that's its own task.
* Migrating historical PRs so they appear in the load history. The 14d
  window naturally rolls forward; backfill is unnecessary.
* In-app UI for `recommendedReviewerScores`. Field is for inspection /
  tuning, not display.
* Cooldown decay (option C in the design discussion). The freshness filter on
  slot 2 + the multiplicative penalty on slot 1 already cover that case.

## Technical Notes

* The Firestore query `where('triagedAt', '!=', null)` is unsupported in
  Firestore (`!=` requires composite indexes that GitSync hasn't built).
  Use `where('triagedAt', '>', new Date(0))` instead — same effect, indexed.
* Order by `triagedAt` desc + `.limit(LOAD_RECENT_PR_CAP)`. Compose-index
  cost is one new index; document in the task notes if Firestore complains.
* `pickReviewers` is currently a tiny pure function. Keep the new helper +
  rewrite under ~150 LOC so the function stays inspectable end-to-end.
* `recentTriageLoad()` runs ONCE per triage, in `triagePr()` BEFORE
  `pickReviewers()`. The result is passed in, so `pickReviewers` stays
  testable without Firestore mocks (existing tests don't need fake DB).
