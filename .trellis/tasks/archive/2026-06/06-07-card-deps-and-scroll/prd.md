# Card-based dependency editing + delete; scrollable board columns

Addresses three user reports about graph/task editing.

## Issues & causes (repo inspection 2026-06-07)
1. **Added node doesn't show in 關聯圖** — a manually-added task has no deps, so
   it's an *isolated* node; graphview's Sugiyama stacks isolated nodes at (0,0),
   under the top-left legend. Fix: let the user pick a parent (prerequisite) from
   the task-detail **card**, which connects it into the DAG so it lays out.
2. **Overflow with many tasks** — each `_BoardColumn`'s card list is a plain
   `Column` (`tasks_board_page.dart`), not scrollable → vertical overflow. Make
   each column scroll independently (fill + phone modes).
3. **No visible delete** — delete is only a graph long-press menu item. Add a
   delete action to the task-detail card too.

## Requirements
1. **TaskDetailsPage — dependency editor**: in the "Depends on" section, each
   prerequisite gets a remove (✕); an "Add prerequisite" button opens a
   **scrollable** picker of other tasks (exclude self, current deps, and choices
   that would cycle). Uses `TasksBoardViewModel.addDependency` /
   new `removeDependency`.
2. **TaskDetailsPage — delete**: an AppBar delete action → confirm →
   `deleteTaskBridging` → back to the board.
3. **Board columns scrollable**: each column fills the available height and its
   card list scrolls (ListView); keep drag-and-drop + fill/phone layouts.
4. Move the graph legend to top-right so isolated nodes at (0,0) aren't hidden.

## Acceptance Criteria
* [ ] Can add/remove a task's prerequisites from the card; cycles rejected.
* [ ] Newly added + linked task appears connected in the graph.
* [ ] Many tasks → columns scroll, no overflow stripes.
* [ ] Delete from the card works (with bridging). analyze + tests green.

## Out of Scope
* Drag-to-connect in the graph; editing other task fields from the card.
