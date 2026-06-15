# Discord digests: show all days in the visible range

## Root cause of "digest 還是沒有"

Recovery worked (39 messages, digests exist for 2026-06-03 and 2026-06-04),
but the Discord tab renders ONE digest card — the day the pointer picks
(viewEnd → savedEnd → today). The saved/view range ends on TODAY, whose
digest doesn't exist yet → blank, while older digests sit invisible.

## Decision

Mirror the Summary tab's per-day model: the Discord tab shows a digest card
for EVERY day in the visible window (view range → saved range → today) that
has a digest doc. Days without a digest are skipped (no placeholder).
Newest day first. Each card keeps its existing collapse / lock / "ask AI to
adjust" behavior — which must now operate on THAT card's date, not a single
VM-global date.

## Requirements

1. `DiscordDigestRepository`: add `streamDigestsInRange(repoId, startKey,
   endKey)` (documentId range over YYYY-MM-DD ids, same pattern as
   DailyReportRepository.streamReportsInRange). Fake repo parity.
2. `DiscordMessagesViewModel`: replace the single-digest subscription with a
   range subscription over the visible window; expose
   `List<DiscordDigest> digests` (each digest already knows its date — verify
   the model carries it; if not, map doc id in). `editDigest`/`toggleLock`
   take the target date (or the digest) instead of using the global
   `_digestDateKey`. Per-date busy/error state where cheap (a single
   in-flight flag keyed by date is fine).
3. Discord tab: render the digest cards list (newest first) above the chat,
   inside the existing layout; empty window → keep current "no digest" state.
4. Tests: multi-day fake digests render N cards; edit/lock dispatch carries
   the tapped card's date; a range ending on a digest-less day still shows
   the earlier days' cards (the regression that motivated this).

## Acceptance Criteria

* [ ] Range 6/3–6/5 with digests on 6/3+6/4 shows BOTH cards (today missing
  digest no longer blanks the section).
* [ ] Lock/edit act on the correct per-card date.
* [ ] flutter analyze (known info only) + flutter test green; functions
  untouched.

## Out of Scope

* Generating missing digests on demand from this view.
* Backend changes.
