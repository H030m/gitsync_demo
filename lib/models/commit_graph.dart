import 'dart:math' as math;

// Mirrors the `getCommitGraph` callable's payload
// (functions/src/flows/getCommitGraph.ts) — branch-topology data fetched
// on demand from the GitHub API (commit docs in Firestore carry no parents).
//
// Also hosts `buildGraphRows`, the pure lane-assignment pass (the standard
// git log --graph / gitk "active lanes" algorithm) that turns the commit
// list into per-row paint geometry. Kept here (no Flutter imports) so it is
// unit-testable — see test/commit_graph_layout_test.dart.

class GraphCommit {
  final String sha;
  final String message;
  final DateTime committedAt;

  /// Parent SHAs. A SHA not present in the fetched window means the line
  /// runs off-screen (older than the range / un-fetched branch).
  final List<String> parents;

  /// GitHub login; null when the commit email isn't linked to an account.
  final String? authorLogin;
  final String authorName;
  final String? avatarUrl;
  final String primaryBranch;
  final bool isMerge;
  final int? prNumber;

  const GraphCommit({
    required this.sha,
    required this.message,
    required this.committedAt,
    this.parents = const [],
    this.authorLogin,
    this.authorName = '',
    this.avatarUrl,
    this.primaryBranch = '',
    this.isMerge = false,
    this.prNumber,
  });

  factory GraphCommit.fromMap(Map<String, dynamic> map) {
    final author = Map<String, dynamic>.from(map['author'] as Map? ?? {});
    return GraphCommit(
      sha: map['sha'] as String? ?? '',
      message: map['message'] as String? ?? '',
      committedAt:
          DateTime.tryParse(map['committedAt'] as String? ?? '')?.toLocal() ??
              DateTime.fromMillisecondsSinceEpoch(0),
      parents: List<String>.from(map['parents'] as List? ?? []),
      authorLogin: author['login'] as String?,
      authorName: author['name'] as String? ?? '',
      avatarUrl: author['avatarUrl'] as String?,
      primaryBranch: map['primaryBranch'] as String? ?? '',
      isMerge: map['isMerge'] as bool? ?? false,
      prNumber: (map['prNumber'] as num?)?.toInt(),
    );
  }
}

class GraphBranch {
  final String name;
  final String tipSha;
  final bool isDefault;

  const GraphBranch({
    required this.name,
    required this.tipSha,
    this.isDefault = false,
  });

  factory GraphBranch.fromMap(Map<String, dynamic> map) => GraphBranch(
        name: map['name'] as String? ?? '',
        tipSha: map['tipSha'] as String? ?? '',
        isDefault: map['isDefault'] as bool? ?? false,
      );
}

class CommitGraph {
  /// Newest first (the callable sorts by committedAt desc).
  final List<GraphCommit> commits;
  final List<GraphBranch> branches;

  /// True when the branch cap or a per-branch history page limit was hit.
  final bool truncated;

  const CommitGraph({
    this.commits = const [],
    this.branches = const [],
    this.truncated = false,
  });

  factory CommitGraph.fromMap(Map<String, dynamic> map) => CommitGraph(
        commits: (map['commits'] as List? ?? [])
            .map((e) => GraphCommit.fromMap(Map<String, dynamic>.from(e as Map)))
            .toList(),
        branches: (map['branches'] as List? ?? [])
            .map((e) => GraphBranch.fromMap(Map<String, dynamic>.from(e as Map)))
            .toList(),
        truncated: map['truncated'] as bool? ?? false,
      );

  /// tip sha → branch name, for labeling branch heads in the graph.
  Map<String, String> get tipLabels => {
        for (final b in branches)
          if (b.tipSha.isNotEmpty) b.tipSha: b.name,
      };
}

// ---- Branch color mapping ---------------------------------------------------

/// Stable palette slot for a branch name: the same branch always maps to the
/// same color slot across reloads (the lane a branch occupies can change, so
/// keying color on the branch name — not the lane index — keeps it stable).
/// Pure (no Flutter imports here) so the painter can call it for any palette
/// size. Empty/unknown names fold to slot 0.
int branchColorIndex(String branch, int paletteSize) {
  if (paletteSize <= 0) return 0;
  if (branch.isEmpty) return 0;
  // Simple deterministic char-code fold (FNV-ish), kept small and dependency-
  // free; only the modulo matters for the palette slot.
  var hash = 0;
  for (var i = 0; i < branch.length; i++) {
    hash = (hash * 31 + branch.codeUnitAt(i)) & 0x7fffffff;
  }
  return hash % paletteSize;
}

// ---- Lane assignment ("active lanes" algorithm) -----------------------------

/// Paint geometry for one commit row of the branch graph. All lane indices are
/// columns; the painter maps column l to x = laneWidth/2 + l*laneWidth.
class GraphRowGeometry {
  final GraphCommit commit;

  /// The column the node dot sits in.
  final int lane;

  /// Lane has a child above (line from the top edge down to the node).
  final bool topStem;

  /// Lane continues below toward the first parent (node down to bottom edge).
  final bool bottomStem;

  /// Columns whose vertical line passes straight through this row.
  final List<bool> passThrough;

  /// Columns (above the row) whose line converges diagonally into the node —
  /// merge lines from other lanes ending at this commit.
  final List<int> intoNode;

  /// Columns (below the row) that fork diagonally out of the node — extra
  /// parents of a merge commit opening (or joining) other lanes.
  final List<int> outOfNode;

  /// For each lane column active at this row (whether passing through, into, or
  /// out of the node, or the node's own lane), the branch name the line belongs
  /// to — `null` when the lane is free or its branch is unknown. Indexed by lane
  /// column; used to color strokes per BRANCH and to drive the rail-tap popup.
  final List<String?> laneBranches;

  const GraphRowGeometry({
    required this.commit,
    required this.lane,
    required this.topStem,
    required this.bottomStem,
    this.passThrough = const [],
    this.intoNode = const [],
    this.outOfNode = const [],
    this.laneBranches = const [],
  });

  /// Number of columns this row touches (for rail sizing).
  int get laneSpan {
    var span = lane + 1;
    for (var l = 0; l < passThrough.length; l++) {
      if (passThrough[l]) span = math.max(span, l + 1);
    }
    for (final l in intoNode) {
      span = math.max(span, l + 1);
    }
    for (final l in outOfNode) {
      span = math.max(span, l + 1);
    }
    return span;
  }
}

/// Assigns lanes to [commits] (must be newest → oldest, exactly the fetched
/// window) with the standard git-log/gitk active-lanes pass:
///
/// * a lane "expects" the next SHA on its line going down;
/// * a commit sits in the leftmost lane expecting it (other expecting lanes
///   converge into it and are freed — merge collapse), or opens a new lane
///   when nothing expects it (branch tip / child off-window);
/// * its lane then expects its first parent; extra parents (merges) either
///   join the lane already expecting them or open a new lane (fork edge) —
///   loops over all parents, so octopus merges need nothing special;
/// * a first parent missing from the window simply keeps the lane's line
///   running off the bottom edge (off-screen history stub).
List<GraphRowGeometry> buildGraphRows(List<GraphCommit> commits) {
  final active = <String?>[]; // lane → the SHA that lane expects next
  // Parallel to `active`: the branch each lane's line belongs to. Set when a
  // lane starts expecting a sha, carried forward as the lane advances, cleared
  // when the lane is freed — so a lane expecting an off-window sha keeps the
  // branch of the commit that opened it.
  final laneBranch = <String?>[];
  // sha → that commit's primaryBranch, for resolving a lane's expected sha.
  final branchOf = <String, String>{
    for (final c in commits)
      if (c.sha.isNotEmpty) c.sha: c.primaryBranch,
  };
  final rows = <GraphRowGeometry>[];

  int alloc() {
    final free = active.indexOf(null);
    if (free != -1) return free;
    active.add(null);
    laneBranch.add(null);
    return active.length - 1;
  }

  for (final c in commits) {
    final above = List<String?>.of(active);

    var lane = active.indexOf(c.sha);
    final isTip = lane == -1;
    if (isTip) lane = alloc();

    // The node's own lane carries the commit's own branch.
    laneBranch[lane] = c.primaryBranch.isEmpty ? null : c.primaryBranch;

    // Other lanes expecting this commit converge into the node and free up.
    final intoNode = <int>[];
    for (var l = 0; l < active.length; l++) {
      if (l != lane && active[l] == c.sha) {
        intoNode.add(l);
        active[l] = null;
        laneBranch[l] = null;
      }
    }

    // The node's own line continues down toward its first parent.
    final firstParent = c.parents.isEmpty ? null : c.parents.first;
    active[lane] = firstParent;
    if (firstParent == null) {
      laneBranch[lane] = null;
    } else {
      // Prefer the parent's own branch when it's in the window; otherwise keep
      // the branch of this commit (line runs off-screen under its branch).
      laneBranch[lane] = branchOf[firstParent] ?? c.primaryBranch;
      if (laneBranch[lane]!.isEmpty) laneBranch[lane] = null;
    }

    // Extra parents: join the lane already expecting them, else open one.
    final outOfNode = <int>[];
    for (var k = 1; k < c.parents.length; k++) {
      final p = c.parents[k];
      var l = active.indexOf(p);
      if (l == -1) {
        l = alloc();
        active[l] = p;
        final pb = branchOf[p] ?? c.primaryBranch;
        laneBranch[l] = pb.isEmpty ? null : pb;
      }
      if (l != lane) outOfNode.add(l);
    }

    final below = List<String?>.of(active);
    final cols = math.max(above.length, below.length);
    final passThrough = List<bool>.generate(cols, (l) {
      if (l == lane) return false;
      final a = l < above.length ? above[l] : null;
      final b = l < below.length ? below[l] : null;
      return a != null && a == b;
    });

    // Snapshot the branch of every lane this row touches. A lane is "touched"
    // if it's the node's lane, passes through, or is an into/out edge.
    final laneBranches = List<String?>.generate(cols, (l) {
      if (l == lane) return c.primaryBranch.isEmpty ? null : c.primaryBranch;
      if (l < passThrough.length && passThrough[l]) {
        return l < laneBranch.length ? laneBranch[l] : null;
      }
      if (intoNode.contains(l)) {
        // The lane just freed; recover its branch from the row above.
        final a = l < above.length ? above[l] : null;
        if (a != null) return branchOf[a];
        return null;
      }
      if (outOfNode.contains(l)) {
        return l < laneBranch.length ? laneBranch[l] : null;
      }
      return null;
    });

    rows.add(GraphRowGeometry(
      commit: c,
      lane: lane,
      topStem: !isTip,
      bottomStem: c.parents.isNotEmpty,
      passThrough: passThrough,
      intoNode: intoNode,
      outOfNode: outOfNode,
      laneBranches: laneBranches,
    ));

    // Keep the lane list compact so freed right-edge columns are reusable.
    while (active.isNotEmpty && active.last == null) {
      active.removeLast();
      laneBranch.removeLast();
    }
  }
  return rows;
}
