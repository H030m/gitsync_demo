# One date, one refresh — additive Discord, scoped AI reads, unified UX

## Goal (user-confirmed end state)

The Daily page converges on ONE shared date range and ONE shared Refresh in
the AppBar. Discord storage becomes additive-only (no data is ever deleted),
AI reads are scoped to the selected time window, and the per-tab
refresh/date controls disappear.

## Decisions (user-confirmed)

**D1 — Discord storage is additive-only.**
`setDiscordRange` keeps persisting the range + resetting watermarks (so the
bot re-pulls the window; messageId dedup prevents duplicates) but NO LONGER
deletes anything (remove the prune of out-of-window discordMessages and
discordDigests). With deletion gone, binding the shared range to Discord is
safe again.

**D2 — AI reads are time-scoped ("讓 AI 讀要記得設定好時間").**
With messages accumulating forever, the Discord chat must read only the
selected window:
* `discordChat` callable accepts optional `startDate`/`endDate` (YYYY-MM-DD,
  both-or-neither, validate like getCommitGraph).
* `searchDiscordMessages` gains an optional range filter (timestamp >= start,
  < end+1d — reuse taipei day-bounds helpers); `listDaySummaries`/digest
  reads filter date keys to the window.
* The agent system prompt mentions the active window so it doesn't try to
  read outside it.
* Flutter `DiscordChatViewModel` passes the shared range (view → saved →
  today, same precedence as display) with every question.
(dailyBrief is already range-scoped — unchanged.)

**D3 — One refresh, one date (AppBar).**
* The AppBar (next to the existing shared date picker) gains ONE Refresh
  button that refreshes everything for the current window:
  - Commits: `loadGraph(force: true)` (list view is realtime anyway).
  - Discord: re-request backfill for the visible window (enqueue
    `requestDiscordFetch` per day in the window, capped at 31 days; bot
    dedups) so missing days fill in.
  - Summary: nothing (reports stream realtime; generation stays per-day).
* Shared range change ALSO persists the Discord range via `setRange` (now
  additive-safe, D1) — display and saved range stay in sync again.
* REMOVE: the Discord tab's "設定回補範圍" button, its own Refresh button;
  the Commits tab's refresh IconButton and scope/date label row remnants.
  Keep the Commits view toggle + filter chips. Keep `setViewRange` plumbing
  only if still needed; collapse it into the simpler bound flow.

**D4 — Discord digest panel mirrors the Summary panel.**
Digest cards live in a fixed-height (≤ ~45% viewport) internally-scrolling,
collapsible panel ("Digest" header + count + chevron), same widget pattern
as `_ReportsPanel`. Extract a shared collapsible-panel widget if cheap,
otherwise mirror.

**D5 — Discord chat gets 開啟新 session** (same as the Summary brief chat):
`DiscordChatViewModel.newSession()` + the restart_alt IconButton, disabled
while in flight.

## Acceptance Criteria

* [ ] `setDiscordRange` deletes nothing (test: out-of-window docs survive).
* [ ] `discordChat` with a range only surfaces in-window messages/digests
  (unit test on the search tool's range filter + handler arg validation).
* [ ] AppBar refresh triggers: graph force reload + per-day Discord fetch
  requests for the window (≤31 days).
* [ ] Discord/Commits tabs have NO local refresh/date/backfill controls.
* [ ] Digest panel: ≤45% height, internal scroll, collapsible; per-day cards
  unchanged inside.
* [ ] Discord chat has a working new-session button.
* [ ] All gates green (functions typecheck/lint/test, flutter analyze/test).
* [ ] Deploy `setDiscordRange` + `discordChat`.

## Out of Scope

* Storage archival/cleanup tooling (additive-only accepted; revisit if usage
  ever grows).
* Changing dailyBrief (already scoped).

## Technical Notes

* Prune code: `functions/src/handlers/setDiscordRange.ts` (deleteAll + the
  two prune queries) — remove; keep range persist + watermark reset.
* `searchDiscordMessages` (functions/src/tools/discordSearch.ts) scans
  recent messages with orderBy timestamp desc — add optional `{since, until}`
  Timestamps to the query.
* `requestDiscordFetch` is per-day; the Flutter VM loops the window's days.
* Frontend panel pattern: `_ReportsPanel` in daily_view_page.dart.
* DiscordChatViewModel: lib/view_models/discord_chat_vm.dart; it must learn
  the shared window — wire from `_onRangeChanged` like the other VMs.
