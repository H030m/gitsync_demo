# Complete the Stats page with real charts

## Decisions (user-confirmed)

* **fl_chart** dependency approved (ARCHITECTURE line ~982 planned it).
* Four charts: task-status donut, commits-per-author bar, daily-commits trend
  (last 14 days), member task load (per-assignee in-progress/done).

## Requirements

1. Add `fl_chart` to pubspec (latest compatible).
2. `StatsViewModel` grows derived data: `commitsPerDay` (day → count over the
   last 14 days, from the loaded commits), `memberLoad` (assigneeId →
   {inProgress, done} from tasks), and joins member display names (wire
   MembersViewModel as a third upstream via ChangeNotifierProxyProvider3;
   fall back to the raw id/login when no member match).
3. StatsViewPage renders the four charts in _StatCards: donut w/ legend +
   center total; vertical bar chart per author (GitHub login labels, branch
   palette colors fine); line/bar trend with day labels (MM/dd, sparse);
   stacked or grouped bars for member load with legend. Empty states (no
   data → EmptyState or hint) per card. Theme colors via colorScheme — no
   hardcoded chart colors beyond the existing lane palette.
4. Unit tests for the new VM derivations (day bucketing incl. empty days,
   load counts, name join). Widget smoke test: page renders all four cards
   with fake data.
5. Caveat to note in code: trend/author charts derive from the loaded
   commits window (recent 50 / picked range on the Daily page) — document,
   don't over-engineer a separate query.

## Acceptance Criteria

* [ ] Four charts render with fake-mode data; legends/labels readable in
  light + dark.
* [ ] VM derivations unit-tested; flutter analyze (known info only) + tests
  green; functions untouched.
