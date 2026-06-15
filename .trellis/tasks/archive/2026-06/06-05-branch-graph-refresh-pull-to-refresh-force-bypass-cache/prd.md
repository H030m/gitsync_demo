# Branch graph refresh (pull-to-refresh + force bypass cache)

## Goal

The Commits tab's branch graph is fetched on demand (getCommitGraph, 90s backend cache)
and never updates while on screen — new pushes don't appear until the page is re-entered
or the range changes. Add manual refresh that guarantees fresh data.

## Requirements

1. Backend: `getCommitGraph` accepts `force?: boolean`; the flow skips the cache READ
   when force (still writes the fresh payload back) — mirrors explainCommit's force.
2. Flutter service: `getCommitGraph(..., force)` param (live + fake).
3. VM: `loadGraph({force})`; refresh keeps current graph visible while reloading
   (no flash to spinner when data already on screen).
4. UI: pull-to-refresh (RefreshIndicator) on the branch-graph list + a refresh
   IconButton in the Commits header row (mouse-friendly). Both use force=true.

## Acceptance Criteria

* [ ] Pulling down (or tapping refresh) refetches; a push made after the first load
  appears without leaving the page.
* [ ] force bypasses the 90s cache (backend test: cache fresh + force → fetch called).
* [ ] Existing graph stays visible during refresh; errors keep the retry state.
* [ ] functions typecheck/lint/tests + flutter analyze/test green.

## Out of Scope

* Auto-polling / realtime updates for the branch view (author view is already realtime
  via Firestore stream).

## Decision (ADR-lite)

Manual refresh only (user-confirmed): cheap and predictable; realtime needs are served
by the author view's stream.
