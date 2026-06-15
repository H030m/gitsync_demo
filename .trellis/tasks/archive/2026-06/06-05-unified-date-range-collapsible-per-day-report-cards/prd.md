# Unified date range + collapsible per-day report cards

## Goal

Two user-confirmed UX changes on the Daily page:
1. The Summary tab's upper section becomes a list of **collapsible per-day
   report cards** (one card per day in the selected range, same interaction
   model as the Discord `_DigestCard`).
2. **One shared date range** drives all three tabs (Summary / Commits /
   Discord) — picked once, applied everywhere.

## Decisions (ADR-lite, user-confirmed)

**D1 — Per-day collapsible report cards.**
Selecting 6/1–6/5 shows 5 cards (one per day). Collapsed: date + one-line
summary. Expanded: the day's full report (summary, highlights, blockers,
commit themes, contributions — reuse the existing report card content
widgets). A day with no report shows a "產生日報" (generate) button calling
`summarizeDay(startDate=endDate=that day)`. Mirror `_DigestCard`'s
collapse/expand interaction (tappable header, animated chevron). Default
state: today expanded, other days collapsed.

**D2 — One range, fully bound (全部綁死).**
A single shared range state; changing it updates: Summary day cards range,
the daily-brief chat scope, Commits list/graph filter, Discord message/digest
display AND triggers the Discord backfill range (`setDiscordRange`) — the
user explicitly accepted the side effect (watermark reset + bot re-fetch on
range change). Clearing the range returns every tab to its default (Summary:
today; Commits: Recent 50; Discord: today).

**D3 — 502 hardening is OUT of this task** (user deprioritized; "works now").
Known risk recorded: GitHub GraphQL 502s are intermittent — the bulk query's
`associatedPullRequests(first:1)` join (20 branches × 100 commits) rides
GitHub's ~10s internal limit. If it recurs: drop that field from the bulk
query (PR numbers via message regex), guard `data?.repository`, retry once.

## Requirements

1. New shared range holder (e.g. `IntelRangeViewModel`, ChangeNotifier) in
   the ShellRoute MultiProvider (`lib/router/app_router.dart`); nullable
   `DateTimeRange` (null = per-tab defaults).
2. ONE picker UI on the Daily page (replacing the three per-tab pickers) +
   a clear/reset affordance (keep the Commits "Recent 50" chip semantics —
   it now clears the shared range).
3. DailyViewPage wires shared-range changes to: `DailyReportViewModel`,
   `DailyBriefChatViewModel`, `CommitsViewModel` (list + graph),
   `DiscordMessagesViewModel` (display + `setDiscordRange`).
4. `DailyReportRepository` gains `streamReportsInRange(repoId, start, end)`
   — Firestore range on the `date` field (YYYY-MM-DD strings, lexicographic);
   client-side filter drops composite range docs (`date` containing `_`).
   Fake repo implements it too.
5. Summary upper section renders the day cards (D1); per-day generate +
   regenerate; loading/error states per card; existing range-report behavior
   replaced by the card list.
6. Update/extend widget tests: day cards render for a multi-day range,
   expand/collapse works, generate button calls summarizeDay for that day,
   shared picker updates all three tabs' VMs.

## Acceptance Criteria

* [ ] Picking a range once changes what all three tabs show; clearing resets
  all three to defaults.
* [ ] Summary shows one collapsible card per day in range; collapsed shows
  date + summary line; expanded shows full report; missing-report day offers
  generate.
* [ ] Discord backfill range fires on shared-range change (per D2).
* [ ] flutter analyze (only the known info) + flutter test green; functions
  untouched (or green if touched).

## Out of Scope

* getCommitGraph 502 hardening (D3 note above).
* Backend changes to summarizeDay / reports schema (per-day docs already
  exist; generation callable already supports single-day).
* Persisting the shared range across app restarts.

## Technical Notes

* Collapse pattern: `_DigestCard` (`daily_view_page.dart:2200+`) — tappable
  header + AnimatedRotation chevron + conditional body.
* VMs provided in ShellRoute (`app_router.dart:69-92`); add the shared range
  notifier there so Tasks-page navigation doesn't reset it.
* `DailyReportViewModel`/`DailyBriefChatViewModel` already have
  `setRange(start, end)` (used by the old Summary picker); Commits VM has
  `setRange`/`clearRange`; Discord VM `setRange` triggers the callable.
* Watch test harness: `test/commits_tree_test.dart` and
  `test/daily_summary_tab_test.dart` build DailyViewPage with explicit
  providers — they must gain the new shared notifier.
