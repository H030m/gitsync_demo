# Revert AnimatedSwitcher bottom-nav swap (GlobalKey duplication crash)

## Goal

Remove the bottom-nav page-swap animation introduced in task
`06-13-ui-polish-…transition-animations` to stop the
`Duplicate GlobalKey detected … KeyedSubtree-[<0>]` crash users hit when
switching tabs at runtime. Everything else from that task stays:
`AppMotion` tokens, modal-sheet motion, dialog motion, list-stagger,
indicator pill animation.

Follow-up task `06-13-…custom-transition-page-at-gorouter-level` will
re-introduce the directional slide the correct way (per-route, no shared
widget tree) — it's queued planning-only.

## Root cause (already diagnosed)

`AnimatedSwitcher` keeps the outgoing AND incoming children alive for the
duration of a swap. Both `KeyedSubtree(child: widget.child)` wrappers
contain the GoRouter shell's routed subtree, which embeds a
`GlobalObjectKey(int#…)` somewhere down the tree (likely a Flutter
framework or third-party widget keyed by a stable model hashCode). The
framework can't have the same GlobalKey in two places, throws
`Duplicate GlobalKey detected in widget tree`, and our `KeyedSubtree-[<0>]`
ends up named as the parent that lost its child during reparenting.

This pattern is fundamentally incompatible with the shell when the routed
subtree owns GlobalKeys — the right architecture is per-route transition
pages (`CustomTransitionPage`), not a shell-level switcher.

## Fix (locked)

In `lib/views/shell/repo_shell.dart`:

* Remove the `AnimatedSwitcher` wrapper around the routed body.
* Remove the `_previousIndex` state field, the `goingRight` derivation,
  the post-frame `_previousIndex` update, and the inline `KeyedSubtree`.
* Set `body: widget.child` directly, as it was before task
  `06-13-ui-polish-…transition-animations` touched it.
* Keep the `_SlidingBottomNav` indicator pill animation untouched — it's
  unrelated to the crash and the user-visible polish of that pill is fine.
* Keep all `AppMotion` imports + usages elsewhere in the file (e.g. any
  `AppMotion.nav` referenced by the indicator pill duration if applicable).
* Leave the inline comment block at lines ~156–199 either removed or
  shortened to a one-liner saying "see task X for why the page-swap
  animation was moved to the route level".

## Requirements

* Single-file change: `lib/views/shell/repo_shell.dart`.
* No other file touched.
* No new files.
* No `pubspec.yaml` change.

## Acceptance Criteria

* [ ] `flutter test` — 98 tests still green.
* [ ] `flutter build web` — green.
* [ ] Manual smoke on Chrome (Path B): cycle through all four bottom-nav
      tabs, including a mid-flight tab switch. No "Duplicate GlobalKey"
      error in the console. Page swap is instant (no animation) — this is
      the deliberate trade-off; the directional slide returns via the
      follow-up task.
* [ ] Modal sheets, dialogs, list stagger, and indicator pill all still
      animate correctly — none of those were the source of the crash.

## Definition of Done

* AC items pass.
* `flutter analyze` skipped (CJK-path tooling bug per project memory).
* Single commit.

## Out of Scope

* Re-introducing the page-swap animation (handled by the queued follow-up
  task `…custom-transition-page-at-gorouter-level`).
* Touching modal sheets, dialogs, lists, AppMotion tokens, or any other
  file outside `repo_shell.dart`.
* Investigating which third-party / framework widget owns the
  `GlobalObjectKey(int#…)` — we're sidestepping the problem entirely by
  removing the shell-level switcher, not patching around it.

## Technical Notes

* This is a deliberate UX regression in exchange for stability. The
  follow-up task immediately schedules the proper fix (per-route
  `CustomTransitionPage`), which is the architecture this kind of
  animation needs.
* `KeyedSubtree-[<0>]` in the crash trace = our wrapper with
  `ValueKey<int>(0)`. After this revert, no such widget exists in the
  tree.
