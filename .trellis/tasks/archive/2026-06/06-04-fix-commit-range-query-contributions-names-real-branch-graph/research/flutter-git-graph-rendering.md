# Research: Rendering a git branch graph (commit DAG) in Flutter

- **Query**: How to render a real git branch graph (commit DAG with lanes, fork/merge
  edges, newest-at-top, gitk / GitKraken / GitHub-network style) in a Flutter Material 3
  app, given a list of commits `{sha, parents[], branchHint, committedAt, author}`.
- **Scope**: mixed (internal codebase + external library/algorithm knowledge)
- **Date**: 2026-06-04

> Tooling note: the live web-search MCP tools named in the task brief
> (`mcp__exa__web_search_exa`, `mcp__exa__get_code_context_exa`) and WebSearch are **not
> available** in this environment. External facts below come from established, stable
> knowledge of these packages/algorithms. Anything version- or date-sensitive is flagged
> **[verify live]** — confirm on pub.dev / the repo before committing to it. The internal
> findings (file paths, code, existing deps) are read directly from this repo and are
> authoritative.

---

## Findings

### Internal: what already exists in this repo

| File Path | Description |
|---|---|
| `lib/views/daily/daily_view_page.dart:785-1158` | The current Commits tab. `_CommitsTab` -> `_CommitTree` (a `ListView.builder`) -> `_CommitTreeRow` -> `CustomPaint(_LanePainter)`. **Per-row CustomPaint** rail, one cell per row. |
| `lib/views/daily/daily_view_page.dart:938-975` | `_buildTreeRows` — flattens commits into `_TreeRow`s (day-header rows + commit rows) and assigns **lanes per author** (`laneOf[c.author.login]`), capped at `_maxLanes = 6`. A lane line spans from a lane's first (newest) to last (oldest) commit index. This is the algorithm we are replacing for the branch view. |
| `lib/views/daily/daily_view_page.dart:913-929` | `_TreeRow` model: `{dayLabel?, commit?, lane, activeLanes: List<bool>}`. `activeLanes[l] == true` means "a vertical line passes through this row in lane l" — precomputed geometry, painter is dumb. Good model to evolve. |
| `lib/views/daily/daily_view_page.dart:1120-1158` | `_LanePainter` — for each active lane draws a vertical line `x = laneWidth/2 + l*laneWidth`; draws the node dot on the commit's own lane, vertically centered. **Only draws straight vertical lines + a dot; no diagonal fork/merge edges.** |
| `lib/views/daily/daily_view_page.dart:1033-1034` | Tap-to-explain is an `InkWell(onTap: ...)` wrapping the whole row -> `_showCommitSheet` -> `vm.explain(sha)`. Hit-testing is per-row widget, not canvas geometry. |
| `lib/views/tasks/widgets/task_graph_tab.dart` | **Existing `graphview` usage** — the TasksBoard "Graph" tab. `Graph()` + `Node.Id` + `addEdge`, `SugiyamaAlgorithm(SugiyamaConfiguration())` top-bottom, wrapped in `InteractiveViewer` (pan/zoom, `constrained: false`). Node widgets via `builder:`. This is a free-canvas pan/zoom layout, **not** a vertically scrolling list. |
| `lib/models/commit.dart` | `Commit {sha, repoId, message, author(CommitAuthor{login,name,email}), url, filesChanged, additions, deletions, linkedTaskIds, aiSummary?, committedAt}`. **No `parents` and no `branch` field** — confirmed. The graph's `parents[]`/`branchHint`/`avatarUrl` must come from the new `getCommitGraph` callable (PRD decision **D1**), not from this model as-is. |
| `pubspec.yaml:37` | `graphview: ^1.2.0` **is already a dependency.** No new package needed if we reuse it; but see the recommendation for why we likely should *not* reuse it for this view. |

PRD context that constrains this (from `prd.md`):
- **D1**: graph data comes on-demand from a new `getCommitGraph(repoId, range)` callable that
  hits the GitHub API and returns commits **with `parents[]`**. So the Flutter side receives
  a ready list; it does the lane assignment + painting.
- **D2**: the branch graph is a **sibling view** toggled against the existing per-author tree
  map; both keep the shared range filter and tap-to-explain.
- Niceties (req 5): author avatar/name on nodes, PR number on merge nodes.
- Out of scope: zoom/pan, branch filtering, commits only reachable from deleted branches.

---

### 1. pub.dev packages for git graphs / DAG drawing

**[verify live] All version numbers / "last updated" below should be re-checked on pub.dev
before relying on them — they move.**

| Package | What it is | Fit for *this* (vertical list, fork/merge lanes, 200-1000 rows) |
|---|---|---|
| **`graphview`** (already in `pubspec.yaml ^1.2.0`) | General graph layout: tree (Buchheim-Walker), layered (Sugiyama), force-directed (Fruchterman-Reingold). Renders the whole graph into a sized canvas; you pan/zoom via `InteractiveViewer`. MIT-style permissive license. | **Poor fit.** It is a *layout engine for arbitrary graphs*, not a git-lane renderer. Sugiyama would re-layer commits by topological depth, not keep them in committer-time order with one node per row at a fixed row height — you lose the "newest at top, one commit per scroll row, time-ordered" property that makes a git log readable. It also lays out the *entire* graph eagerly (no row virtualization), so 200-1000 nodes is heavy and there is no `ListView` virtualization. Good for the *task dependency* DAG (small, unordered) — wrong tool for a commit log. |
| **`flutter_graph_view`** | Force-directed / business-relationship graph visualization (Apache-2.0). | Poor fit — same reasons as graphview, oriented at relationship graphs, animated force layout, not a time-ordered scrolling commit list. |
| **`graphite`** | Directed-graph layout (layered). | Poor fit — layout engine, same family as graphview. |
| gitgraph.js ports | `gitgraph.js` / `@gitgraph/*` is a mature **JS/TS** library (GitKraken's open template-style commit graph). **[verify live] No maintained, popular pure-Dart/Flutter port is known** as of the knowledge cutoff. Treat "there is a ready Flutter gitgraph widget" as false until proven on pub.dev. | N/A — would only matter via webview, which is not worth it here. |
| **`scidart` / generic canvas libs** | Not graph-specific. | N/A. |

**Conclusion for (1):** there is **no off-the-shelf Flutter widget that draws a git commit
graph the way gitk/GitHub-network does** (time-ordered, one commit per row, lanes with
fork/merge edges, virtualized scroll). The packages that exist are general DAG *layout*
engines whose layout model fights the requirement. The existing `graphview` dep is justified
for the TasksBoard DAG but is the wrong abstraction for the commit log. This matches the
PRD's own technical note ("no obvious off-the-shelf git-graph widget — likely CustomPainter +
lane-assignment algorithm").

---

### 2. The standard lane-assignment algorithm (git log --graph / gitk / Sourcetree)

This is the well-known **"active branch lines" / column-assignment** algorithm. Process
commits **in display order (newest -> oldest, i.e. reverse-topological / by committer date)**
and maintain a list of *open lines* — each open line is a lane that is currently "waiting" for
a specific commit SHA to appear.

**State**
- `activeLanes: List<String?>` — index = lane (column) number, value = the SHA that lane is
  currently *expecting* to draw next (i.e. the next commit that line is reaching down toward),
  or `null` if the lane is free.

**Per commit `c` (processed newest -> oldest):**

1. **Find c's lane.** Look for the lane(s) in `activeLanes` whose expected SHA == `c.sha`.
   - If found, `c` sits in the **leftmost** such lane (its column). Any *other* lanes that
     were also expecting `c.sha` are **merge lines converging into c** -> those extra lanes
     get **freed** after drawing a merge edge from that lane into c's column (this is the
     merge collapse; it's what frees a column so the graph stays narrow).
   - If not found (c is a branch *tip* / head not referenced by any open line, e.g. the newest
     commit on a branch), **allocate** a new lane: reuse the leftmost `null` slot, else append
     a new column. That lane now belongs to `c`.

2. **Replace c's lane with c's first parent.** Set `activeLanes[cLane] = c.parents[0]` (the
   line continues straight down toward the first parent). If `c` has **no parents** (root
   commit), free the lane (`null`).

3. **Handle extra parents = forks/branch sources (this is where lanes are *born* going
   downward).** For each additional parent `c.parents[k>=1]`:
   - If some existing lane is already expecting that parent SHA, draw a **merge edge** from
     c's column to that lane (the two histories join below) — do **not** allocate a new lane.
   - Else **allocate a new lane** for that parent (leftmost free slot / append) and set it to
     expect `c.parents[k]`. This is the diagonal **fork edge** going down-and-out from c.
   - **Octopus merge (>2 parents):** nothing special — just loop over all `parents[1..n]`; each
     is either merged into an existing lane or allocated a fresh one. The algorithm is already
     n-ary; the only cost is width (an octopus can open several lanes in one row).

4. **Edges this row.** For drawing, a commit row needs to know, for **every lane**:
   - pass-through: lane `l` is active above AND below this row (a straight vertical segment),
   - the **node** lane (c's own column, draw the dot),
   - **incoming-from-above** diagonals: a lane that existed above and now bends into c's column
     (merge converge) or out to a new column (fork) — i.e. the lane's column index *changed*
     between the row above and this row.
   The clean way: compute, for row `i`, `lanesAbove` (snapshot of `activeLanes` before
   processing `c`) and `lanesBelow` (snapshot after). An edge is drawn for any lane whose
   slot is occupied in either snapshot; a **diagonal** when the SHA's column index differs
   above vs below (or appears/disappears at c's column).

**Edge cases relevant here:**

- **Parents outside the fetched window** (range filter limits the commits): a commit's
  `parents[k]` may reference a SHA that will *never* appear in the list (its parent is older
  than the range, or unreachable). Detect this up front: build `present = Set(all shas)`.
  - For the **first parent** missing: the lane simply **runs off the bottom** — keep drawing
    its vertical line to the bottom edge of the last row (a "this history continues below the
    window" stub). Optionally fade it.
  - For **extra parents** missing: still draw the fork/merge edge stub a short way out and
    stop at the bottom edge; don't allocate a lane that nothing will ever close (or allocate
    it but mark it "dangling" so it paints a short stub then ends).
  - Symmetrically, a commit whose **children** are above the window (its line should come
    *from* the top): the lane should be drawn from the very top edge. Because we allocate a
    lane on first sight (step 1 "not found -> allocate"), a commit that is actually a
    non-tip but whose child is outside the window just looks like a tip — acceptable, draw
    its line from the top edge.

- **Lane reuse / churn:** always prefer the **leftmost free lane** when allocating, and free
  merged lanes promptly, so the graph stays as narrow as possible (this is exactly what keeps
  gitk from drifting rightward). A hard width cap (like the current `_maxLanes`) can collapse
  overflow lanes into the last column for pathological histories.

- **Color:** gitk/GitKraken color **by lane index** (cycling palette) — the repo already has
  `_laneColors` (`daily_view_page.dart:902-909`) for exactly this; reuse it but key by
  **lane**, not by author.

**References (conceptual, [verify live] for exact wording):**
- `git log --graph` source: `git/graph.c` (`struct git_graph`, columns/new_columns,
  `GRAPH_COMMIT`/`GRAPH_COLLAPSING` states) — the canonical implementation of the above.
- gitk (`gitk` Tcl, `assigncolor` / `drawlineseg`) — same active-lines idea.
- Widely re-described as the "git graph lane assignment" / "swimlane" algorithm in many blog
  write-ups of building a commit grapher.

---

### 3. Single CustomPainter canvas vs per-row CustomPaint in ListView.builder

| Concern | Per-row `CustomPaint` cell (current approach) | One big `CustomPainter` canvas |
|---|---|---|
| **Virtualization / memory (200-1000 commits)** | `ListView.builder` only builds visible rows -> only visible painters exist. Scales fine to thousands of rows. | A single canvas sized `rows * rowHeight` paints **everything every frame** (unless you clip + skip off-screen segments manually). For 1000 rows this is wasteful and can jank. You must re-implement viewport culling yourself. |
| **Drawing edges that span rows** | **Hard.** Each cell only knows its own height; a diagonal fork edge from row i's node down into row i+1's column must be split: the painter for row i draws the **bottom half** of the diagonal (from node center to its bottom edge in the child column), and the painter for row i+1 draws the **top half** (from its top edge in that column to its node). Requires each `_TreeRow` to carry both `lanesAbove` and `lanesBelow` so the two halves meet at the shared row boundary. Doable, and it's the standard trick for list-based graphs. | **Easy.** One canvas has all node Y positions, so a fork/merge edge is a single `Path` (line or cubic bezier) from `(x_parentLane, y_child)` to `(x_childLane, y_parent)` — no splitting. This is the main reason single-canvas is tempting. |
| **Hit-testing for tap-to-explain** | **Easy + already done.** The row is an `InkWell`; tapping anywhere on the row opens that commit. No geometry math. Matches current behavior exactly. | **Manual.** A `GestureDetector` over the canvas must map tap `dy -> row index` (`(dy / rowHeight).floor()`), and you lose the free `InkWell` ripple unless you re-add it. More code, easy to get wrong with headers/variable heights. |
| **Day-header rows / variable heights** | Natural — headers are just other rows in the list. | Awkward — a single canvas wants uniform `rowHeight`; interleaving headers means a row-offset table. |
| **Reuse of existing code** | Reuses `_CommitTree`/`_TreeRow`/`_LanePainter` structure almost verbatim — evolve `_LanePainter` to also draw diagonals using `lanesAbove`/`lanesBelow`. | Throws away the row structure; new gesture + culling code. |

**Hybrid that most list-based git graphs actually use:** keep the **`ListView.builder` +
per-row `CustomPaint`** structure (for virtualization + free hit-testing), and solve the
spanning-edge problem by giving every row the lane snapshot **above and below** it, so each
painter draws the half-edges that meet exactly at the shared row boundary. Visually
continuous, fully virtualized. This is the sweet spot for 200-1000 rows on mobile.

---

### 4. How OSS Flutter git clients draw commit graphs

**[verify live]** — confirm against the current repos; from knowledge as of cutoff:

- **GitJournal** (Flutter, notes-on-git): focuses on note editing over a git repo. Its UI is
  **note/file lists, not a commit-graph swimlane**. Not a useful reference for lane drawing.
- **GitTouch** (a.k.a. "git_touch", Flutter GitHub/GitLab/Bitbucket client): renders commit
  **lists** and rich GitHub data, but is **not known to draw a gitk-style lane graph** —
  commit history is a flat list with author/SHA, similar to this repo's *non-graph* commit
  list. Not a lane-algorithm reference.
- **General finding:** I could not identify a well-known **Flutter** OSS client that ships a
  true multi-lane commit graph. The mature lane renderers live in **non-Flutter**
  ecosystems: `git log --graph` (C), gitk (Tcl), `gitgraph.js` (JS/Canvas, GitKraken),
  SourceTree/GitKraken (proprietary). The portable artifact is therefore the **algorithm**
  (section 2), not a Flutter dependency.

So: no Flutter prior art to copy a widget from — implement the algorithm + a CustomPainter.

---

## Recommendation (ONE approach)

**Reuse the existing pattern: `ListView.builder` + per-row `CustomPaint`, driven by a proper
git lane-assignment pass. Do NOT use `graphview` for this view, and do NOT introduce a new
package.**

Rationale:
1. **Virtualization for free** — 200-1000 commits scroll smoothly because only visible rows
   build/paint. A single canvas or `graphview` would layout/paint all of it eagerly.
2. **Tap-to-explain for free** — the row stays an `InkWell` -> `vm.explain(sha)`, identical to
   the current tree map and the per-row author view; no canvas hit-test math (PRD D2 requires
   tap-to-explain on both views).
3. **Minimal new surface** — it evolves the proven `_CommitTree`/`_TreeRow`/`_LanePainter`
   trio already in `daily_view_page.dart`; the sibling-view toggle (D2) sits cleanly next to
   it; `_laneColors` is reused keyed by lane.
4. **`graphview` is the wrong abstraction** — it re-layers nodes by topology and renders the
   whole graph in a pan/zoom canvas (see `task_graph_tab.dart`), destroying the time-ordered,
   one-commit-per-row, newest-at-top reading that makes a commit log legible. It rightly stays
   the tool for the *task dependency* DAG, not the commit log.
5. Spanning fork/merge edges are solved with the **above/below lane snapshot** trick, which is
   the established approach for list-based graphs.

### Lane-assignment data structure (sketch)

```dart
/// Input: commits already sorted newest -> oldest (display order),
/// each with sha + parents[] (from getCommitGraph). present = {all shas in window}.

class GraphRow {
  final Commit commit;          // null for a day-header row, like today
  final int lane;               // c's own column (where the node dot sits)
  final List<String?> above;    // activeLanes snapshot BEFORE processing c
  final List<String?> below;    // activeLanes snapshot AFTER processing c
  final List<MergeEdge> edges;  // diagonals to draw within/around this row
  final bool firstParentOffWindow; // parent missing -> line runs off bottom
}

class MergeEdge {       // one diagonal that bends between columns at this row
  final int fromLane;   // column above the boundary
  final int toLane;     // column below the boundary
  final bool isFork;    // fork (out) vs merge (in) — affects which half/curve
}

/// activeLanes[l] = sha that lane l is currently expecting (its next commit),
/// or null if free. Allocation = leftmost null slot, else append.
List<GraphRow> buildGraphRows(List<Commit> commits) {
  final active = <String?>[];                 // lane -> expected sha
  final present = {for (final c in commits) c.sha};
  final rows = <GraphRow>[];

  int allocLane() {                            // leftmost free, else grow
    final i = active.indexOf(null);
    if (i != -1) return i;
    active.add(null);
    return active.length - 1;
  }

  for (final c in commits) {
    final above = List<String?>.from(active);  // snapshot before

    // 1. find c's lane (lanes expecting c.sha). leftmost = node column;
    //    others are merges converging -> free them, record merge edges.
    var lane = active.indexOf(c.sha);
    if (lane == -1) lane = allocLane();        // branch tip / child off-window
    for (var l = 0; l < active.length; l++) {
      if (l != lane && active[l] == c.sha) {
        // merge edge from lane l into c's column; free l
        active[l] = null;                       // record MergeEdge(l -> lane, merge)
      }
    }

    // 2. continue straight down to first parent (or free if root)
    active[lane] = c.parents.isEmpty ? null : c.parents[0];
    final firstParentOff =
        c.parents.isNotEmpty && !present.contains(c.parents[0]);

    // 3. extra parents = forks: reuse a lane already expecting it, else alloc
    for (var k = 1; k < c.parents.length; k++) {   // k>=1 handles octopus
      final p = c.parents[k];
      final existing = active.indexOf(p);
      if (existing != -1) {
        // fork/merge edge from c's column to existing lane
      } else {
        final nl = allocLane();
        active[nl] = p;                            // record MergeEdge(lane -> nl, fork)
      }
    }

    final below = List<String?>.from(active);  // snapshot after
    rows.add(GraphRow(commit: c, lane: lane, above: above, below: below, /* edges */));
  }
  return rows;
}
```

### Row model + painter

- **Row widget**: same as `_CommitTreeRow` — `InkWell(onTap: explain)` wrapping
  `Row[ SizedBox(width: laneWidth*cols) CustomPaint(_GraphLanePainter), Expanded(text column
  with avatar + message + sha + time + PR-number chip on merge nodes) ]`. Avatar from
  `author.avatarUrl` (CircleAvatar / `NetworkImage`); merge nodes (`parents.length >= 2`)
  get the `#N` PR chip parsed from the commit message (req 5).
- **`_GraphLanePainter`** (evolves `_LanePainter`): for each lane present in `above` or
  `below`, draw the vertical pass-through segment; for each `MergeEdge`, draw a **cubic bezier
  / diagonal** as two halves — the **bottom half** (node center -> bottom edge at the target
  column) is drawn by the *child* row and the **top half** (top edge -> node center) by the
  *parent* row, so they meet at the row boundary x for that column. Draw the node dot on
  `lane` (ring + fill), colored `_laneColors[lane % len]`. `firstParentOffWindow` -> draw the
  lane's vertical line all the way to the bottom edge as a continuing stub.
- **Column width**: `x(l) = laneWidth/2 + l*laneWidth`, identical to current. Keep a
  `maxLanes` collapse so pathological histories don't paint over the text column.

### Net change footprint
New: a `buildGraphRows` lane pass (pure Dart, unit-testable — good for the DoD's flutter
tests), a `GraphRow`/`MergeEdge` model, and a `_GraphLanePainter` that adds diagonals. The
 `ListView.builder`, `InkWell` tap, header rows, range filter, `_laneColors`, and the
explain sheet are all reused. The view toggle (D2) selects between `_buildTreeRows`
(author) and `buildGraphRows` (branch).

---

## Caveats / Not Found

- **No live web verification was possible** (no web-search/fetch tool in this environment).
  All pub.dev versions, package "last updated" dates, licenses, and the GitJournal/GitTouch
  behavior claims are **[verify live]** before relying on them. The internal repo facts
  (file paths, the `graphview ^1.2.0` dep, the Commit model lacking `parents`/`branch`, the
  existing per-row painter) are read directly from the repo and are solid.
- **No maintained pure-Flutter git-graph widget was identified.** If one is desired, search
  pub.dev for `git graph` / `commit graph` / `gitgraph` and check maintenance before
  trusting it; the safe, recommended path is the algorithm + CustomPainter above.
- **Data dependency**: this UI is only as good as `getCommitGraph` returning correct
  `parents[]` and stable display ordering. Lane assignment assumes commits arrive in
  **display order (newest -> oldest)** and that `present` covers exactly the rendered window;
  confirm the callable sorts and that off-window parents are detectable (PRD D1 / out-of-scope
  note about deleted-branch commits applies).
- **`branchHint`** from the input is useful for *coloring/labeling* a lane (e.g. show the
  branch name on its tip) but is **not** needed by the core lane algorithm — lanes are derived
  purely from `sha`/`parents[]`. Treat `branchHint` as decoration.
