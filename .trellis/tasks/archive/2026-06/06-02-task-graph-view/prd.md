# Render dependency graph in TasksBoard Graph tab

## Goal

Replace the `Graph view — TODO` stub (the second tab of `TasksBoardPage`) with a
real dependency-graph (DAG) visualization of the repo's tasks, using their
`dependsOn` edges. The AI breakdown now populates `dependsOn` correctly
(verified live), but no screen renders the relationships — this task adds that.

## What I already know (from repo inspection)

* `lib/views/tasks/tasks_board_page.dart` — already a `DefaultTabController`
  with two tabs: "Board" (kanban, implemented) and "Graph" (`Icons.account_tree`).
  Graph tab body is literally `const Center(child: Text('Graph view — TODO'))` (line 43).
* `TasksBoardViewModel` exposes `tasks` (each a `Task` with `id`, `title`,
  `status`, `dependsOn: List<String>` of real taskIds), plus `repoId`, `loading`,
  `todo`/`inProgress`/`done`.
* `Task.status` is `TaskStatus { todo, inProgress, done }` — use for node color.
* Tap navigation exists: `NavigationService.goTaskDetails(repoId, taskId)`.
* `dependsOn` data layer is fully wired (model/repo/Firestore query); confirmed
  non-empty in live Firestore.

## Decision (ADR-lite)

* **Context**: need to draw a node/edge DAG of ~5-12 shallow tasks in Flutter.
* **Decision**: use the **graphview** pub.dev package (user-approved new dep) with
  **`SugiyamaConfiguration`** (layered top-down layout, ideal for DAGs). Chosen
  over custom `CustomPaint` (would require hand-rolling layout + arrows + pan/zoom)
  and over `fl_chart` (charts, not node graphs).
* **Consequences**: one new Flutter dependency (still Flutter-only, no external
  server → within course constraint). Layout/edges handled by the package.

## Requirements

* Add `graphview` (latest stable, ~`^1.2.0`) to `pubspec.yaml`; `flutter pub get`.
* Implement the Graph tab as a widget that builds a `Graph` from `vm.tasks`:
  * One node per task; node widget = compact card showing the task title,
    colored by `status` (todo / in_progress / done).
  * One edge per `dependsOn` entry: from the **prerequisite** task → the
    dependent task (arrow points along completion order). Skip dangling edges
    whose target id isn't in the current task set (defensive).
  * `SugiyamaConfiguration` (top-down), wrapped in an `InteractiveViewer` so the
    user can pan/zoom.
  * Tap a node → `NavigationService.goTaskDetails(vm.repoId, taskId)`.
* Empty state: if `vm.tasks` is empty, show a friendly "No tasks yet" placeholder
  instead of an empty canvas.
* Keep the Board tab and the rest of the page unchanged.

## Acceptance Criteria

* [ ] Graph tab renders a DAG: nodes = tasks, edges = dependsOn, no stub text.
* [ ] Node color reflects task status; tapping a node opens its details.
* [ ] Pan/zoom works; layout is readable for ~5-12 nodes.
* [ ] Empty task list shows a placeholder, not a crash/blank.
* [ ] Tasks with no deps still appear as isolated nodes.
* [ ] `flutter analyze` clean; existing tests still pass.

## Definition of Done

* `flutter analyze` + `flutter test` green.
* New dependency recorded in pubspec; `pubspec.lock` updated.
* Spec/notes updated if a reusable Flutter-graph convention emerges.
* Manual smoke (user runs `flutter run`) confirms the live graph renders.

## Out of Scope

* Backend changes (none — data already correct).
* Editing dependencies from the graph (drag to connect, delete edges).
* Drag-and-drop kanban on the Board tab (separate work).
* Auto-layout tuning beyond Sugiyama defaults.

## Technical Notes

* graphview API: build `Graph()`, `graph.addEdge(Node.Id(a), Node.Id(b))`,
  render with `GraphView(graph: g, algorithm: SugiyamaAlgorithm(config), builder:
  (node) => <widget for node.key!.value>)`. Verify exact API against the
  installed version (API has shifted across graphview releases).
* Node id = task.id (String). Map id → Task for the builder.
* Wrap in `InteractiveViewer(constrained: false, ...)` for pan/zoom.
