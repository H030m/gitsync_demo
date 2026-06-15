# Show standalone (unlinked) tasks as their own nodes in the graph

## Problem
A task with no dependencies/dependents (degree 0) is invisible in the 關聯圖:
graphview's Sugiyama parks edgeless nodes at (0,0), overlapping the DAG's first
node. So manually-added tasks "don't appear".

## Fix
Split tasks into connected (in ≥1 dependency edge) and isolated. Build the
GraphView from connected only; render isolated tasks in their own "Unlinked"
strip (a labeled horizontal row) above the DAG, inside the same pan/zoom canvas.
Each isolated task shows as its own standalone node with the same tap / long-press
(open / link / delete) behavior, so it's visible and can be linked into the DAG.

## Acceptance Criteria
* [x] Newly added (unlinked) task is visible in the graph immediately.
* [x] Linking it (card or long-press) moves it into the DAG. analyze + tests green.
