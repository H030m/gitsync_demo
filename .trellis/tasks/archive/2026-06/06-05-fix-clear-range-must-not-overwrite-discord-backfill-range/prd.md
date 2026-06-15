# Fix: clearing the shared range must not overwrite the Discord backfill range

## Root cause (regression from 06-05 unified-date-range task)

`_DailyViewPageState._onRangeChanged` (lib/views/daily/daily_view_page.dart)
calls `discord.setRange(now, now)` on CLEAR. `DiscordMessagesViewModel.setRange`
is the heavy "set saved backfill range" action: it persists
`discordStartDate/discordEndDate` on the repo doc (setDiscordRange callable,
watermark reset) and the digest card follows the saved range's END day. So
clearing the shared picker (or tapping "Recent 50") silently overwrites the
team's saved Discord range to today — today has no digest doc → the digest
card disappears. User report: "discord digest 不見了".

Digest docs themselves are untouched in Firestore; only the pointer moved.

## Fix

1. On CLEAR, do NOT touch the Discord VM at all — its display follows the
   repo-doc-saved range (repo stream listener), which is the correct "default".
   Keep the SET branch as-is (D2: picking a range intentionally drives the
   backfill).
2. Comment the why at the clear branch (setRange == persistent backfill write).
3. Update the propagation test: clear → Discord VM untouched (settingRange
   stays false / no new setDiscordRange call on the fake), other three VMs
   reset as before.

## Acceptance Criteria

* [ ] Clearing the shared range never calls DiscordMessagesViewModel.setRange.
* [ ] Setting a range still propagates to all four VMs (existing test).
* [ ] flutter analyze (known info only) + flutter test green.

## Out of Scope

* Restoring the user's previously-saved Discord range value (they re-pick it
  once in the app; data unharmed).
* Splitting Discord view-range from saved-range (revisit if D2 binding ever
  loosens).
