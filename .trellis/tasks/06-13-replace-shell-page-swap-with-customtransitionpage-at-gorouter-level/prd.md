# Replace shell page-swap with CustomTransitionPage at GoRouter level

## Goal

Re-introduce the bottom-nav directional slide between tabs the *correct*
way — per-route at the GoRouter layer (`CustomTransitionPage`) — so each
route owns its own widget tree and there are no overlapping `GlobalKey`s
like the shell-level `AnimatedSwitcher` attempt caused.

## Repo state (auto-context, 2026-06-13)

* Router: `lib/router/app_router.dart`. `GoRouter` with a top-level
  `ShellRoute` mounting four child routes by exact path:
  * `/repos/:repoId/tasks` → `TasksBoardPage` (index 0)
  * `/repos/:repoId/daily` → `DailyViewPage` (index 1)
  * `/repos/:repoId/stats` → `StatsViewPage` (index 2)
  * `/repos/:repoId/settings` → `SettingsPage` (index 3)
* All four currently use `builder:` (not `pageBuilder:`) — these are the
  ones we switch. Sub-routes (`tasks/add`, `tasks/:taskId`) stay on
  `builder:` — they're not shell tabs.
* Bottom-nav onTap: `context.go('/repos/${widget.repoId}/${_items[i].segment}');`
  in `lib/views/shell/repo_shell.dart`. Tab order matches the index list above.

## Decisions (locked 2026-06-13)

* **Transition style**: shared-axis horizontal slide + cross-fade.
  Mirrors the bottom-nav indicator's horizontal motion. Material 3's
  standard pattern for tab-like navigation. Same visual goal as the
  reverted shell-level attempt.
* **Animation values**: enter from `Offset(±0.06, 0)`, exit to
  `Offset(∓0.06, 0)`. Duration = `AppMotion.nav` (300 ms). Curve =
  `AppMotion.emphasized` on both `CurvedAnimation`s. Fade via
  `FadeTransition(opacity: animation)` parented inside the slide.
* **Direction signal**: a tiny module-level `_ShellNavSignal` singleton
  in `lib/router/shell_transitions.dart` exposing two static fields:
  ```dart
  static int previousIndex = 0;
  static bool goingRight = true;
  ```
  Bottom-nav `onTap` updates them atomically BEFORE calling `context.go`:
  ```dart
  void _onTap(int i) {
    _ShellNavSignal.goingRight = i >= _ShellNavSignal.previousIndex;
    _ShellNavSignal.previousIndex = i;
    context.go('/repos/${widget.repoId}/${_items[i].segment}');
  }
  ```
  The `transitionsBuilder` on each route reads `_ShellNavSignal.goingRight`
  every frame, so BOTH the outgoing page's exit slide and the incoming
  page's enter slide use the same direction value for the same
  navigation event. (Capturing at `pageBuilder` time would mis-direct the
  outgoing page's exit on direction-reversing taps — verified by reasoning
  through the lifecycle.)
* **Shared transition builder**: lives in
  `lib/router/shell_transitions.dart` as
  `Widget sharedAxisSlide(BuildContext ctx, Animation<double> anim,
  Animation<double> secAnim, Widget child)`. All four shell routes
  reference this one function so the design is single-sourced and
  retunable.
* **Page key**: each `CustomTransitionPage` uses `state.pageKey` so
  GoRouter can distinguish pages correctly (default behavior; just being
  explicit).
* **Sub-routes** (`tasks/add`, `tasks/:taskId`) keep `builder:` and use
  GoRouter's default Material/Cupertino transition (push-from-the-side).
  Out of scope for this task — only the four shell tabs change.
* **GlobalKey risk**: gone by construction. Each shell route is a separate
  `Page` in the Navigator stack; their trees never co-exist as siblings
  of a common parent like the shell-level `AnimatedSwitcher` did.

## Files to touch

1. **NEW** `lib/router/shell_transitions.dart` — `_ShellNavSignal` class +
   `sharedAxisSlide` builder.
2. `lib/router/app_router.dart` — four shell routes switched from
   `builder:` to `pageBuilder:` returning `CustomTransitionPage` with the
   shared transition.
3. `lib/views/shell/repo_shell.dart` — `_onTap` updates `_ShellNavSignal`
   before `context.go`. (Two-line change.)

## Requirements

* Single transition function shared across all four routes (single
  source of truth, no copy-paste).
* `AppMotion.nav` + `AppMotion.emphasized` consistent with the rest of
  the polish task — no new hard-coded literals.
* No widget in the routed subtree is wrapped or modified — the fix is
  purely at the route / shell-nav level.
* No new pubspec entries.

## Acceptance Criteria

* [ ] Tapping each of the four bottom-nav tabs (in both directions, and
      jumping non-adjacent tabs) plays a horizontal slide + fade. The
      slide direction matches the direction the indicator pill just
      moved.
* [ ] No `Duplicate GlobalKey detected` exception in the console at any
      point during normal tab cycling, including rapid mid-flight tab
      taps.
* [ ] The outgoing page slides toward the side it's leaving from, and
      the incoming page slides in from the side it's entering — i.e. the
      pages move *together*, not in opposite-then-same directions like
      the reverted attempt's last-known bug.
* [ ] Pushing a sub-route (e.g. tapping a task card → task details) still
      uses the default push animation (we didn't touch sub-routes).
* [ ] Browser back / Android back gesture reverses the animation direction
      automatically via `secondaryAnimation` — no extra wiring needed.
* [ ] `flutter test` — 98/98 green.
* [ ] `flutter build web` — green.

## Definition of Done

* All AC items pass.
* `flutter analyze` skipped per project memory (CJK-path bug).
* No widget tests added for animations themselves (not unit-testable),
  but any refactor to `app_router.dart` must not break existing tests
  that instantiate the router.

## Out of Scope

* Animating sub-routes (`tasks/add`, `tasks/:taskId`).
* Hero transitions (e.g. kanban card → task detail).
* Animating non-shell routes (`/`, `/repos`, `/notify`).
* Adding the `animations` Flutter community package — implementing the
  shared-axis pattern manually keeps the no-new-packages rule from the
  polish task.

## Technical Notes

* Reading `_ShellNavSignal.goingRight` inside `transitionsBuilder`
  (not capturing it in `pageBuilder`) is deliberate — every frame of
  the active transition reads the latest module-level value, so both
  the outgoing and incoming pages of the same navigation event agree on
  direction. Capturing at `pageBuilder` time would store the previous
  navigation's direction on the outgoing page, breaking direction
  reversals.
* `state.pageKey` is GoRouter's stable per-route key; we pass it
  explicitly to make the intent clear and to avoid any future
  duplicate-key warnings.
* The `_ShellNavSignal` singleton is allowed even though it's mutable
  global state because (a) the state is two ints, (b) it's read/written
  only on the main isolate during navigation, and (c) the alternative
  (a `RouteObserver` or a `Notifier` plumbed through `ChangeNotifierProvider`)
  is meaningfully more code for the same result. Documented inline.
* No widget-test exists for the shell's swap animation; AC is verified
  by manual smoke per the team's standing Chrome / Path B workflow.
