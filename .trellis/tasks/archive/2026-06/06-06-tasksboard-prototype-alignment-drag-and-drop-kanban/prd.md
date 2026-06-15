# TasksBoard: prototype alignment + drag-and-drop kanban

## Prototype (source of truth: references/GitSync tasks/TasksBoard.tsx)

* AppBar title 任務; two MD3 tabs 看板 / 關聯圖; FAB (+) bottom-right → AddTodo.
* 看板: HORIZONTALLY scrollable row of fixed-width (~140-160dp) columns
  待辦 / 進行中 / 完成. Each column: tonal header (per-column tint) with the
  accent-colored label + a count chip (accent @ 20% bg); card list on a
  secondary background; cards = white/elevated rounded-xl, task title +
  an assignee-initial circle bottom-right (empty grey circle when
  unassigned); tap card → TaskDetails.
* Empty state (all columns empty): centered card — 您還未輸入專案架構 /
  請點擊右下角 + 號來新增 TODOs, with a big + icon circle.
* 關聯圖 tab: layered dependency graph, arrowed edges, node fill gets
  lighter with depth (root darkest, leaf lightest).
* NOTE: TodoDeps.tsx duplicates this graph as a standalone page — decision:
  do NOT add a redundant page; its visual language informs the 關聯圖 tab.

## Decisions

**D1 — Faithful 看板 restyle** per the prototype (CJK labels 任務/看板/
關聯圖/待辦/進行中/完成; tonal column headers via colorScheme containers;
count chips; assignee initial circle resolved from task.assigneeId — show
'?'/empty circle when none; horizontal scroll; empty-state card with the
prototype copy).

**D2 — Drag-and-drop**: LongPressDraggable (mobile-friendly) card +
DragTarget per column → TasksBoardViewModel.updateStatus (already exists).
Visual feedback: dragged card elevated ghost, target column highlights
(border/tint) while hovering. Status writes through the existing repo
method; errors surface via snackbar in the view.

**D3 — 關聯圖 styling nudge (light touch)**: keep TaskGraphTab's real
Sugiyama graph; adopt arrowheads if graphview supports cheaply, otherwise
keep edges; ensure node palette reads as levels where feasible WITHOUT
rewriting the layout. (Standalone TodoDeps page: out of scope, redundant.)

## Acceptance Criteria

* [ ] Board matches the prototype structure (tabs, tonal headers, count
  chips, assignee circles, horizontal scroll, FAB, empty state copy).
* [ ] Long-press dragging a card to another column updates its status in
  Firestore (fake repo in tests); target highlight visible during hover.
* [ ] Existing graph tab still works.
* [ ] flutter analyze (known info only) + flutter test green; functions
  untouched. Widget tests: drag updates status; empty state shows; count
  chips reflect column sizes.

## Out of Scope

* Standalone TodoDeps page (redundant with the 關聯圖 tab).
* AddTodo 3-step flow (its own follow-up task).
* Within-column manual ordering.
