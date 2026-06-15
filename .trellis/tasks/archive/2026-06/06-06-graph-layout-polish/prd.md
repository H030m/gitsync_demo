# Polish the task dependency graph layout (關聯圖)

## Goal
The dependency DAG (`lib/views/tasks/widgets/task_graph_tab.dart`, `graphview`
Sugiyama) looks messy: long sweeping curved edges crossing whitespace, uneven
node heights, lots of empty space, no legend, opens unscaled. Make it read
cleanly, taking cues from how other tools draw dependency/flow graphs.

## Research — how others do it / library capability (2026-06-06)
* **graphview** (pub.dev) Sugiyama supports `orientation` =
  TOP_BOTTOM / BOTTOM_TOP / LEFT_RIGHT / RIGHT_LEFT, `nodeSeparation`,
  `levelSeparation`, `coordinateAssignment` (DownRight/…/Average), and
  `bendPointShape` (curved vs sharp). No native orthogonal router.
  Sources: pub.dev/packages/graphview, Dart API docs.
* **Common patterns** (n8n, GitHub Actions, Linear, react-flow/dagre): left→right
  pipeline flow for dependencies; uniform node size; generous level gap + tight
  in-level gap; short, soft bends (smoothstep) with clear arrowheads; a fit-to-
  view on open; subtle status legend.

## Levers available here
1. Orientation (LR pipeline vs refined TB).
2. nodeSeparation / levelSeparation tuning + coordinateAssignment.
3. Uniform node width + min height; current is width 152, variable height.
4. Edge: softer/thinner, shorter curve, keep arrowheads.
5. Add a status legend; fit-to-view (InteractiveViewer initial scale) on first layout.

## Open Question
* Orientation/style direction (ask user with previews) → then implement.

## Acceptance Criteria
* [ ] Cleaner, more even layout; legend present; opens reasonably framed.
* [ ] Tap-to-open + pan/zoom still work; analyze + tests green.

## Out of Scope
* Switching graph libraries; custom edge router; editing deps from the graph.
