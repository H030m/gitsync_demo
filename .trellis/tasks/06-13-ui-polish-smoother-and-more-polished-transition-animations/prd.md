# UI polish: smoother + more polished transition animations

## Goal

Tighten the perceived quality of the Flutter app's transitions so motion feels
intentional and coordinated, not "platform-default + a few scattered widgets".
Scope to be locked in brainstorm — the surface is wide, the budget is not.

## What I already know (repo inspection, 2026-06-13)

* **Router**: `go_router ^14.0.2`, top-level `GoRouter` at
  `lib/router/app_router.dart:34`. All routes use default `GoRoute` builders —
  no `CustomTransitionPage`. Means page-to-page is whatever Material/Cupertino
  default ships.
* **Bottom nav (`lib/views/shell/repo_shell.dart:151–337` `_SlidingBottomNav`)**:
  the indicator pill animates beautifully (300ms `easeOut`, custom controller),
  but the page content underneath **cuts** to the new route. The polished nav
  leads, the page lags — most likely the #1 thing that reads as "rough".
* **Modal sheets / dialogs** — all defaults. 4 `showModalBottomSheet`
  callers (`ask_repo_sheet.dart:23`, `task_details_page.dart:126,196`,
  `status_picker.dart:16`) and 1 `showDialog` (delete confirm at
  `task_details_page.dart:228`). No custom transition durations / curves.
* **List item appearance** — no `AnimatedList` / `Hero` / `TweenAnimationBuilder`
  used anywhere. Status changes and filter toggles cause instant rebuilds.
  `AnimatedSize` is used for collapsible groups (`tasks_board_page.dart:287`,
  `daily_view_page.dart:396/545/2451`), and `AnimatedRotation` for one chevron.
* **Tab swaps** (`Daily` view's `TabBarView`) use platform default — likely
  abrupt on Android.
* **Theme switch** — Material 3's implicit fade, not overridden. Probably
  already fine; not worth touching unless explicitly bad.
* **Motion tokens** — there is NO `AppMotion` (mirroring `AppDimens`). Inline
  `Duration(ms: 200/250/300)` and `Curves.ease*` are scattered across views.
  Memory note already says the UI uses `AppDimens` + centralized theme
  factory — adding `AppMotion` would match house style.

## Assumptions (temporary — flag if wrong)

* "Smoother and more polished" means a coordinated, *visible* improvement —
  not invisible micro-tweaks. The user wants to feel a difference.
* Tasteful, not flashy. We're matching Material 3 motion guidance + house
  style, not a marketing splash screen.
* No new packages — Flutter built-ins (`AnimatedSwitcher`, `PageRouteBuilder`,
  `CustomTransitionPage`, `Hero`, `AnimatedSize`, implicit animators) only.
* Adding a small `AppMotion` token set (durations + curves) as part of the
  polish so the result is consistent and future work has a vocabulary.

## Decisions (locked 2026-06-13)

* **Scope = B**: bottom-nav content swap (#1) + modal sheets & dialogs (#2)
  + list item entrance/exit (#3) + shared `AppMotion` tokens (#5).
  Tabs (#4) and Hero (#6) are deferred to follow-up tasks.

* **Motion tokens (`lib/theme/app_motion.dart`)** — Material 3 expressive
  scale, named so each token has an obvious use site:

  ```dart
  class AppMotion {
    // Durations — Material 3 emphasized scale.
    static const Duration short  = Duration(milliseconds: 150);  // micro
    static const Duration medium = Duration(milliseconds: 250);  // sheet fade,
                                                                 // list item
    static const Duration nav    = Duration(milliseconds: 300);  // matches the
                                                                 // existing
                                                                 // _SlidingBottomNav
                                                                 // indicator
    static const Duration long   = Duration(milliseconds: 450);  // hero / large

    // Curves.
    static const Curve standard         = Curves.easeInOutCubic;
    static const Curve emphasized       = Cubic(0.20, 0.00, 0.00, 1.00);
    static const Curve emphasizedAccel  = Cubic(0.30, 0.00, 0.80, 0.15);
    static const Curve emphasizedDecel  = Cubic(0.05, 0.70, 0.10, 1.00);
  }
  ```

  All scattered inline `Duration(milliseconds: 200/250/300)` and
  `Curves.easeOut/easeInOut` literals in views that we're touching get
  swapped to these. Untouched views stay untouched (no drive-by sweep).

* **Modal sheets + dialogs (#2)** — keep Material defaults' direction, just
  tune the timing:
  - `transitionAnimationController` set so duration = `AppMotion.medium`,
    curve = `AppMotion.emphasizedDecel` on enter / `emphasizedAccel` on exit.
  - Barrier color animates to match (`barrierColor` with the same controller).
  - No new shape, no drag-handle redesign — out of scope, only motion.

* **List item entrance/exit (#3)** — per-tile `TweenAnimationBuilder<double>`
  + `Opacity` + small `Transform.translate(dy: 8 → 0)`. Stagger by **index**
  with a per-item delay of `AppMotion.short / 4 ≈ 38 ms`, capped at the
  first **8 items** (anything beyond just uses the base duration with no
  per-index delay, so a long list doesn't visibly cascade past the fold).
  Triggers: first build of a list view + insertion. Removal: reverse Tween
  on dismiss where the source already tracks the item lifecycle (kanban
  cards + daily summary cards). No `AnimatedList` — overkill for our list
  sizes.

* **Bottom-nav content swap style (#1)** — **shared-axis horizontal slide**.
  Old page slides off in the direction the indicator just moved, new page
  slides in from the opposite side. Duration = `AppMotion.nav` (300 ms),
  curve = `AppMotion.emphasized` so timing locks to the indicator. Fixed
  slide offset (NOT "by N tabs") so a jump from tab 1 → tab 4 doesn't read
  as a giant lurch — the indicator already encodes distance.

## Open Questions

* None. All design choices locked.

## Likely-rough hot spots (from scoping)

Ordered by my read of impact-per-effort:

1. **Bottom-nav content swap mismatch** — instant content change while the
   indicator slides 300ms. Highest-perceived-quality fix.
2. **Modal sheet & dialog feel** — generic Material defaults. Easy bump to a
   slightly more refined curve/duration + light shadow handoff.
3. **List item entrance/exit** — kanban cards, daily-summary cards, task
   rows. Stagger + fade-in on first appearance, fade-out on dismiss.
4. **Tab swaps in Daily view** — `TabBarView` default vs. a coordinated
   cross-fade or slide-with-momentum.
5. **Shared `AppMotion` tokens** — supporting work that makes all of the
   above consistent + cheaper to extend.
6. **Hero transitions** — kanban card → task detail page (high-impact "wow"
   moment if added; more effort).

## Requirements

* **`AppMotion` token module** at `lib/theme/app_motion.dart` exporting the
  durations + curves listed above. Documented inline.
* **Bottom-nav content swap (`lib/views/shell/repo_shell.dart`)**:
  * Track previous tab index in the shell's state.
  * Wrap the routed child in an `AnimatedSwitcher` with a custom
    `transitionBuilder` that returns a `SlideTransition` keyed by the
    direction of tab change (new index > old → enter from right, else
    from left), parented by a `FadeTransition`.
  * Slide offset: fixed `Offset(0.06, 0)` (~6 % of viewport width) — feels
    like motion without lurching.
  * `Duration = AppMotion.nav`, `Curve = AppMotion.emphasized`.
  * `IndexedStack`-like state preservation is preserved — the `AnimatedSwitcher`
    swaps a `KeyedSubtree` per route, not the underlying state.
* **Modal sheets + dialogs (4 sheets + 1 dialog)**:
  * Each `showModalBottomSheet` callsite gets a `transitionAnimationController`
    built with `AppMotion.medium` + `emphasizedDecel`.
  * The single `showDialog` (delete confirmation) gets a `barrierColor` +
    `transitionBuilder` aligned with the same timing.
* **List item entrance (#3)** — apply to **three** lists where the user
  spends the most time:
  1. Kanban cards (`lib/views/tasks/tasks_board_page.dart`).
  2. Daily summary cards (`lib/views/daily/daily_view_page.dart`).
  3. Task rows / task-list views (the tasks list page).
  * Per-tile `TweenAnimationBuilder<double>` with `Opacity` + 8 px upward
    translate.
  * Stagger: per-index delay = `AppMotion.short ~/ 4` (≈ 38 ms), capped at
    8 items; remaining items use the base duration with no extra delay.
  * Triggers: first render of the list + insertions. Removals: where the
    parent already tracks lifecycle, reverse the tween; otherwise let the
    item rebuild without a reverse (don't bolt on dismiss state we don't have).
* **No drive-by rewrites**: scattered `Duration(milliseconds: ...)` literals
  in files we touch get swapped to `AppMotion`; files we don't touch are
  left alone.

## Acceptance Criteria

* [ ] `lib/theme/app_motion.dart` exists, exports `AppMotion`, is imported by
      every file changed in this task.
* [ ] On bottom-nav tap, the page content and the indicator pill are visibly
      synchronized: both run for ≈ 300 ms with matching ease and the content
      slides in the same direction the pill moves. Verified manually on
      Chrome (Path B).
* [ ] Each modal sheet and dialog opens/closes with the new
      `transitionAnimationController` and the `barrierColor` animates with it.
* [ ] Initial render of the kanban board, daily summary, and task list shows
      a visible top-down staggered fade-in for the first 8 items. Subsequent
      items appear immediately.
* [ ] Inserting a new task/card (e.g. drag-drop to a column, status change)
      shows a single-item fade-in (no full re-stagger of the whole list).
* [ ] Theme switch still smooth (Material 3 default) — no regression.
* [ ] `flutter build web` succeeds.
* [ ] Existing widget tests still pass.
* [ ] No new entries in `pubspec.yaml`.

## Definition of Done

* Tests: animations themselves are not unit-testable, but any widget
  refactor (e.g. extracting a new `AppMotion`) should not break existing
  widget tests.
* Manual smoke on Chrome — confirm the targeted transitions visibly improved.
* Lint clean. (`flutter analyze` crashes on the CJK repo path per the
  team-memory note — skip it intentionally per the prior convention.)

## Out of Scope (explicit, to converge)

* No third-party animation packages (Rive, Lottie, flutter_animate, etc.).
* No theme-switch animation tuning unless the user explicitly flags it.
* No platform-specific (Cupertino) overrides unless we're touching that
  surface anyway.

## Technical Notes

* `go_router` supports per-route `CustomTransitionPage` for declarative
  custom transitions — the standard pattern is to wrap the `pageBuilder`
  (not `builder`) with `CustomTransitionPage(transitionsBuilder: ...)`.
* `showModalBottomSheet` accepts `transitionAnimationController` for
  controlled timing; pairing that with a custom `AnimationController` lets
  us match `AppMotion` exactly.
* For list entrance staggers without a new package, wrap children in
  `TweenAnimationBuilder<double>` keyed by index, with a tiny per-index
  delay (`Future.delayed` or an offset on the curve). Cheaper than
  `AnimatedList` for the small per-screen counts we have.
* Memory: `flutter analyze` crashes on the CJK repo path — known tooling
  bug, ignore. Path B (live Firebase + Chrome) is the smoke target.
