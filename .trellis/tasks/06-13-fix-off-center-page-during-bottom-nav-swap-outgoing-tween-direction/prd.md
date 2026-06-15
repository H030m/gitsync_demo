# Fix off-center page during bottom-nav swap (outgoing tween direction)

## Goal

Fix a regression from task `06-13-ui-polish-…transition-animations`: when
switching tabs, the OUTGOING page visibly snaps sideways before fading out,
making the page look "not in the middle". Pages settle correctly once the
swap completes, but the transient is jarring.

## Root cause (already diagnosed, 2026-06-13)

`lib/views/shell/repo_shell.dart:185–186` — the `SlideTransition` Tween for
the outgoing child has begin/end inverted relative to how AnimatedSwitcher
drives the animation.

AnimatedSwitcher runs the OUTGOING child's animation in REVERSE (value 1 → 0):
* value=1 → the moment the swap starts (page should be at **center**)
* value=0 → the moment the page disappears (page should be at **exitOffset**)

Current Tween for the outgoing child: `begin: Offset.zero, end: exitOffset`.
`Tween.lerp(begin, end, t)` evaluated at value=1 returns `end = exitOffset`,
so the outgoing page **snaps to `exitOffset` the instant the swap begins**,
then slides back toward center as it fades out. Visually: the old page jumps
to one side at the start of every tab swap.

For the incoming child the Tween is correct (`begin: enterOffset, end:
Offset.zero` evaluated at value=0 gives `enterOffset`, at value=1 gives
center).

## Fix (locked)

In `lib/views/shell/repo_shell.dart` `transitionBuilder`:

```dart
// Old (broken)
final beginOffset = isIncoming ? enterOffset : Offset.zero;
final endOffset   = isIncoming ? Offset.zero : exitOffset;

// New (correct — both children land at center at the visible-still moment,
// and at their off-screen offset at the gone moment)
final beginOffset = isIncoming ? enterOffset : exitOffset;
const endOffset   = Offset.zero;
```

Reasoning written into the comment that already explains the direction logic
just above the Tween.

## Requirements

* Edit `lib/views/shell/repo_shell.dart` only. No other files.
* Keep the `isIncoming` detection via `animation.status` (forward/completed)
  — it's correct as written; only the Tween endpoints are wrong.
* Keep `Offset(0.06, 0)` / `Offset(-0.06, 0)` magnitudes unchanged.
* Update or extend the inline comment so the begin/end direction logic is
  obvious to the next reader.

## Acceptance Criteria

* [ ] Manual smoke (Chrome / Path B): tap each of the four bottom-nav tabs;
      the outgoing page does NOT visibly jump sideways at the start of any
      swap. The incoming page still slides in from the indicator's
      direction.
* [ ] Rapidly tap two tabs in succession (interrupt a swap mid-flight): the
      previous outgoing page does not get stranded at an offset position.
* [ ] `flutter test` — existing 98 tests still green.
* [ ] `flutter build web` — green.

## Definition of Done

* AC items all pass.
* `flutter analyze` intentionally skipped (CJK-path tooling bug per project
  memory).
* No additional widgets touched.
* Single-commit change.

## Out of Scope

* The StaggeredEntry vertical translate (correctly converges to zero — not
  the cause of the centering complaint).
* Sheet / dialog motion (unrelated).
* Direction-detection refactor — `animation.status` based detection is fine.

## Technical Notes

* The official Flutter pattern for direction-aware AnimatedSwitcher slides
  uses exactly this convention: the outgoing animation runs in reverse, so
  the Tween should be authored as "at value=1 → still visible, at value=0 →
  fully gone" for both children. Our incoming Tween already follows this;
  the outgoing one was the lone deviation.
* No widget-test exists for the shell's swap animation; adding one would be
  overkill for this one-line fix. AC is verified by manual smoke per the
  team's standing Chrome / Path B workflow.
