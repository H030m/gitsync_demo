# Decouple Discord from shared range + Summary panel UX + chat new session

## Background (incident)

The 06-05 unified-range task bound the shared date range to
`DiscordMessagesViewModel.setRange`, which calls the `setDiscordRange`
callable — and that callable **prunes** (deletes) discordMessages/digests
outside the new window by design (06-03). A clear-branch regression set the
range to today→today and wiped all Discord data (recoverable: the bot
re-ingests from Discord itself). User has now chosen to DECOUPLE.

## Decisions (user-confirmed)

**D1 — Decouple: display follows, backfill is manual.**
* The shared range only scopes what the Discord tab DISPLAYS (messages list +
  which day's digest is shown). Read-only — never calls `setDiscordRange`,
  never deletes anything.
* The Discord tab regains an explicit "設定回補範圍" button (date-range picker
  + the old snackbar) that calls `vm.setRange` (the persistent prune+refetch
  action). This is the ONLY path to the destructive callable.
* DailyViewPage's shared-range fan-out: the SET branch switches from
  `discord.setRange` to a new display-only `discord.setViewRange(start,end)`;
  CLEAR calls `discord.clearViewRange()` (falls back to the saved-range /
  today default). No callable, no prune.

**D2 — Summary day-report panel: fixed height, internally scrollable,
collapsible as a whole.**
* The per-day report cards live in a fixed-height upper panel (cap ≈ 40-45%
  of the viewport height) with its OWN scroll — many days no longer push the
  chat off screen.
* A panel header row ("日報" + count + chevron) collapses/expands the whole
  panel; collapsed shows just the header. Individual day cards keep their own
  collapse behavior inside the panel.

**D3 — Ask-AI chat: "開啟新 session" action.**
* A button in the chat area (e.g. icon in the chat header / input row)
  clears the conversation history in `DailyBriefChatViewModel`
  (`newSession()`: clears turns + any error, keeps the range scope). UI shows
  the emptied thread immediately.

## Requirements

1. `DiscordMessagesViewModel`: add view-range state (`setViewRange`,
   `clearViewRange`) that re-points the message-list scope and the digest day
   WITHOUT calling the callable; saved-range behavior (`setRange`) unchanged
   for the explicit button. Digest pointer precedence: view range end →
   saved range end → today.
2. DailyViewPage `_onRangeChanged`: discord uses view-range methods in both
   branches.
3. Discord tab: restore the explicit backfill picker button (old code shape:
   showDateRangePicker + `await vm.setRange` + snackbar "Tap Refresh to
   backfill"), alongside the read-only shared-scope label.
4. Summary panel per D2 (fixed-height scrollable + collapsible header).
5. Chat new-session per D3.
6. Tests: discord view-range never triggers settingRange/callable; explicit
   button path still does; panel collapse hides cards; new-session clears the
   thread.

## Acceptance Criteria

* [ ] Changing/clearing the shared range NEVER deletes Discord data and never
  calls setDiscordRange (test-asserted).
* [ ] The Discord tab's explicit button still sets the backfill range
  (prune+refetch) with the confirmation snackbar.
* [ ] With a 10-day shared range, the Summary upper panel stays ≤ ~45% of the
  screen and scrolls internally; the panel collapses to a single header row.
* [ ] 問 AI 區有「新 session」按鈕,按下後對話清空、可立即重新提問。
* [ ] flutter analyze (known info only) + flutter test green; functions
  untouched.

## Recovery runbook (after this ships — user executes)

1. Make sure the discord-bot is running (`discord-bot/`, `npm run dev`).
2. Discord tab → 設定回補範圍 → pick the wanted window (e.g. 6/1–6/5) →
   Refresh. Bot re-ingests; digests regenerate. Data loss is fully
   recoverable from Discord itself.

## Out of Scope

* Backend changes (setDiscordRange prune semantics stay; it is now only
  reachable from the explicit button).
* Persisting panel collapse state across restarts.
