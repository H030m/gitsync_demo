# Interactive graph editing: add / connect / delete nodes (cycle-safe deps)

## Goal
Let the user edit the dependency graph directly: add a new task node, create
dependency links between nodes, and delete a node — with the layout
re-positioning automatically and the DAG staying acyclic (graph theory).

## What I already know (repo inspection 2026-06-06)
* `task_graph_tab.dart` renders the DAG via `graphview` Sugiyama. **graphview has
  NO built-in node-drag or edge-drawing** — any "connect" gesture is custom; the
  view is wrapped in `InteractiveViewer(constrained:false)` so pointer→graph
  coordinate mapping for a drag would need manual transform math.
* `dependsOn` lives on the dependent task (edge = prerequisite → dependent;
  `addEdge(depId, taskId)`). Editing a link = editing a task's `dependsOn` array.
* `TaskRepository` has `addTask`, `deleteTask`, `getDependentsOf` — but **no
  `updateDependsOn`** (must add it + Fake). tasks are client-writable (members).
* Re-layout is FREE: changing the graph rebuilds it → Sugiyama recomputes; the
  06-06 fit-to-view re-frames it.

## Graph-theory pieces
* **Cycle-safe linking**: adding "v depends on u" must be rejected if u already
  (transitively) depends on v — DFS reachability over `dependsOn`.
* **Delete + bridge ("自動重新定位")**: deleting node d, optionally reconnect d's
  prerequisites (d.dependsOn) to d's dependents (tasks with d in dependsOn):
  `c.dependsOn = (c.dependsOn − d) ∪ d.dependsOn`. DAG contraction stays acyclic.
* Pure, unit-testable helpers (reachability, bridge).

## Decisions (2026-06-06)
* **Create link = tap-to-connect**: long-press a node → "Link from here" → tap the
  task that depends on it. Cycle-checked; banner + Cancel while in connect mode.
* **Delete = auto-bridge**: reconnect the deleted node's prerequisites to its
  dependents, cycle-safe.
* Direction: first node = prerequisite, second = dependent (second.dependsOn += first).
* Node actions via long-press popup menu (Open / Link from here / Delete); tap = open.
  Add-node via a FAB in the graph tab.

## Acceptance Criteria (draft)
* [ ] Add a node from the graph; it appears + persists.
* [ ] Create a link; cycles are rejected with feedback.
* [ ] Delete a node; chain handled per chosen semantics; layout re-frames.
* [ ] analyze + tests green (incl. graph-helper unit tests); Fake updated.

## Out of Scope
* Switching graph libraries; editing task fields other than deps from the graph.
