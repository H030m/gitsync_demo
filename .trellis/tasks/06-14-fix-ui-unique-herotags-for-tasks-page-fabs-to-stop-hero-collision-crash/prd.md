# fix(ui): unique heroTags for Tasks page FABs

## Goal

Stop the runtime exception thrown during page-route transitions on the
Tasks page:

> There are multiple heroes that share the same tag within a subtree …
> multiple heroes had the following tag: `<default FloatingActionButton tag>`

## Root cause (diagnosed 2026-06-14)

Two `FloatingActionButton`s coexist under the same `TasksBoardPage`
route, both relying on Flutter's default Hero tag for FABs:

* `lib/views/tasks/tasks_board_page.dart:57` — the page-level
  `FloatingActionButton` (Add Task → opens `AddTodoPage`).
* `lib/views/tasks/widgets/task_graph_tab.dart:369` — a
  `FloatingActionButton.small` (Add Node → opens the graph add-node
  dialog) rendered when the graph tab is active.

Whenever any route push happens from this page — task card → details,
add → AddTodoPage, or now the shell-tab swap that
`CustomTransitionPage` introduced — Flutter's Hero traversal walks both
routes and finds two heroes with the same `<default FloatingActionButton
tag>` → assertion fires.

The bug is pre-existing — it would also crash on a default Material
push — but the route-level shell-tab animation makes it more frequent.

## Decisions (locked)

* Give each FAB a unique `heroTag` (strings, not nulls). Disabling the
  hero entirely (`heroTag: null`) loses cross-route visual continuity if
  either ever shares a hero with a future destination; named tags are
  more future-proof at zero cost.
* Tag values describe the FAB's role, not its position:
  * `tasks_board_page.dart` FAB → `heroTag: 'tasks-board-add-fab'`
  * `task_graph_tab.dart` FAB → `heroTag: 'task-graph-add-node-fab'`
* No widget structure changes, no visual changes.

## Requirements

* Add the two `heroTag:` properties as specified.
* No other change to `lib/views/tasks/tasks_board_page.dart` or
  `lib/views/tasks/widgets/task_graph_tab.dart`.

## Acceptance Criteria

* [ ] On the Tasks page, switching to the graph tab no longer logs
      "multiple heroes that share the same tag" when navigating to or
      from another shell tab, or when tapping a task / the FAB.
* [ ] `flutter test` — green (no widget-test was asserting on heroTag).
* [ ] `flutter build web` — green.
* [ ] `flutter analyze` skipped per project memory (CJK-path bug).

## Definition of Done

* AC items pass.
* Single commit on develop.

## Out of Scope

* Auditing other FABs in the app (`repo_list_page.dart` has one too — it
  lives in a different route entirely so it never collides with these
  two; not part of this bug).
* Adding a lint rule that flags missing `heroTag` on FABs — overkill for
  a two-callsite fix; revisit if the issue recurs elsewhere.

## Technical Notes

* `FloatingActionButton.small` accepts the same `heroTag` parameter as
  `FloatingActionButton` — verified in the Flutter SDK docs.
* String tag values were chosen over arbitrary `Object()` instances so
  hot-reload preserves them and they remain stable for future
  Hero animation work (e.g. card → detail-page heroes).
