# Manual single-task creation in the add-task flow

## Goal
The board's "+" (`tasks_board_page.dart` FAB → `goAddTodo`) only opens
`AddTodoPage`, which is **AI-breakdown only** (paste a spec → `breakdownTask`).
There's no way to just add one task by hand in the main flow — add that.

## What I already know
* `AddTodoPage` (`add_todo_page.dart`) is a 2-step AI flow (input → confirm).
* `TasksBoardViewModel.addTask(Task)` exists; the page is under the shell so it
  can read the VM + `AuthenticationService` (for `createdBy`). `Task` needs
  `id:''` (repo assigns it), `title`, optional `description`, `createdBy`.

## Requirements
1. Add a mode toggle (SegmentedButton) at the top of AddTodoPage: **Manual**
   (default) and **AI breakdown** (existing flow, unchanged).
2. Manual mode: title (required) + description (optional) → `vm.addTask` →
   navigate back to the board. Disable submit while busy / title empty.

## Acceptance Criteria
* [ ] Can create a single task manually from the board's "+".
* [ ] AI breakdown still works. analyze + tests green.

## Out of Scope
* Editing other task fields here; changing the AI flow.
