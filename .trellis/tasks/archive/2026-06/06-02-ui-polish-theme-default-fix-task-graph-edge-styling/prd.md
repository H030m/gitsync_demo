# UI Polish: theme default fix + task graph edge styling + app-wide polish

## Goal

Fix two known UI bugs/uglinesses and do a broad visual polish pass across the app
without changing any behavior or business logic.

1. **Theme toggle mismatch** — app defaults to `ThemeMode.system` (follows
   browser/OS), but the Settings "Dark mode" `SwitchListTile` reads
   `value: theme.mode == ThemeMode.dark`, which is `false` when mode is
   `system`. So a user whose browser is dark sees a dark UI but a switch that
   says "off/light" → contradictory.
2. **Task graph edges are ugly** — thin (w=2), grey (`colorScheme.outline`),
   sharp straight/polyline segments. Want smooth curves + arrowheads + a
   themed, more legible color.
3. **General polish** — make the whole app look nicer (consistent spacing,
   cards, typography, empty states) across all main pages.

## Requirements

### R1 — Theme: 3-way selector (no persistence)
* Replace the binary `SwitchListTile` in `settings_page.dart` with a
  `SegmentedButton<ThemeMode>` offering **System / Light / Dark**.
* `value` reflects `ThemeModeNotifier.mode`; selecting a segment calls
  `setMode(...)`. Default stays `ThemeMode.system`.
* No persistence (in-memory only) — confirmed out of scope. Reload returns to
  System; that's acceptable.
* Result: when System is selected it's shown explicitly; the contradiction
  disappears.

### R2 — Task graph edges
* In `task_graph_tab.dart`: set `SugiyamaConfiguration.bendPointShape =
  CurvedBendPointShape(curveLength: …)` (smooth curves) and keep
  `addTriangleToEdge = true` (directional arrowheads — package default).
* Edge `Paint`: themed, legible color (softened `colorScheme.primary` rather
  than faint `outline`), rounded `strokeCap`/`strokeJoin`, tuned width.
* Edges must remain theme-aware (work in light + dark).

### R3 — App-wide polish (visual only, no logic changes)
* Enrich `app_theme.dart` with shared component themes (card shape/elevation,
  AppBar, FilledButton, input, list tile, divider) so polish propagates
  app-wide from one place — highest leverage.
* Light-touch per-page polish where it clearly helps:
  * RepoList: card-based list items, repo icon, nicer empty state.
  * Tasks board: column headers with count chips, nicer task cards.
  * Daily (Summary/Commits/Discord): card layout, avatars/icons, empty states.
  * Task details: sectioned layout, status chip.
  * Stats: card sections (do NOT add fl_chart charts — separate feature).
  * Sign-in: branded logo/title block + subtitle.
  * Settings: section grouping around the new selector.
* Graph nodes: subtle shadow + status accent (small, complements R2).

## Acceptance Criteria

* [ ] Settings shows a System/Light/Dark segmented control; selecting each
      switches the live theme; default selection is System on a fresh load and
      matches the rendered brightness (no contradiction).
* [ ] Task graph edges render as smooth curves with visible directional
      arrowheads, in a themed color, legible in both light and dark.
* [ ] Main pages (RepoList, Tasks board, Daily, Task details, Stats, Sign-in,
      Settings) look visibly more polished and consistent; no layout overflow.
* [ ] `flutter build web` (or run) compiles with no new errors; existing
      behavior/navigation unchanged.
* [ ] No new runtime dependency added (no shared_preferences).

## Definition of Done

* App compiles and runs in live mode on Chrome (analyze is broken by the CJK
  repo path — use build/run as the gate, not `flutter analyze`).
* Manual visual check of each touched page in both light and dark.
* No behavior/logic/route changes; diff is styling-only except the theme
  selector widget swap.

## Technical Approach

* **R1**: `SegmentedButton<ThemeMode>` in `settings_page.dart`; reuse existing
  `ThemeModeNotifier.setMode`. No notifier changes needed.
* **R2**: graphview 1.5.1 already supports curved bends + arrow triangles via
  `SugiyamaConfiguration` (`bendPointShape`, `addTriangleToEdge`) — no custom
  `EdgeRenderer` required. Tune `Paint`.
* **R3**: centralize in `app_theme.dart` `ThemeData` component sub-themes; then
  minimal per-page widget tweaks. Keep `AppColors` seeds as-is.

## Decision (ADR-lite)
**Context**: Theme switch contradicts system default; graph edges look crude;
user wants broad polish.
**Decision**: 3-way selector (no persistence); use graphview's built-in curved
+ arrow edge support (not a custom renderer); centralize polish in theme.
**Consequences**: Theme choice still resets on reload (acceptable, no dep
added). Polish is theme-driven so future pages inherit it. Stats charts remain
a separate future feature.

## Out of Scope
* Theme persistence across reload/restart (no shared_preferences).
* Adding real fl_chart charts to Stats.
* Drag-and-drop kanban, Discord webhook form, and other functional TODOs.
* Any backend/logic/route/model changes.

## Technical Notes
* Files: `lib/views/settings/settings_page.dart`,
  `lib/services/theme_mode_notifier.dart` (likely unchanged),
  `lib/theme/app_theme.dart`, `lib/theme/app_colors.dart`,
  `lib/views/tasks/widgets/task_graph_tab.dart`, plus per-page view files under
  `lib/views/**`.
* graphview source: `~/.pub-cache/hosted/pub.dev/graphview-1.5.1/` —
  `SugiyamaConfiguration` (bendPointShape/addTriangleToEdge),
  `SugiyamaEdgeRenderer` (curve + triangle drawing).
* Gate is build/run, NOT `flutter analyze` (crashes on CJK path).
