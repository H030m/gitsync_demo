import 'package:flutter_test/flutter_test.dart';

import 'package:gitsync/models/commit_graph.dart';

// Pure-Dart tests for the branch-graph lane assignment (active-lanes pass).
// Commits are listed newest → oldest, exactly as `getCommitGraph` returns.

GraphCommit _c(String sha, List<String> parents,
        {int hoursAgo = 0, String branch = ''}) =>
    GraphCommit(
      sha: sha,
      message: 'commit $sha',
      committedAt: DateTime(2026, 6, 4).subtract(Duration(hours: hoursAgo)),
      parents: parents,
      primaryBranch: branch,
      isMerge: parents.length >= 2,
    );

void main() {
  group('branchColorIndex', () {
    test('same branch name maps to the same slot across calls', () {
      expect(branchColorIndex('main', 6), branchColorIndex('main', 6));
      expect(
        branchColorIndex('feature/summary-intel-hub', 6),
        branchColorIndex('feature/summary-intel-hub', 6),
      );
    });

    test('slot is within the palette range and stable per name', () {
      for (final name in ['main', 'dev', 'feature/x', 'release/1.0', '']) {
        final i = branchColorIndex(name, 6);
        expect(i, inInclusiveRange(0, 5));
        expect(i, branchColorIndex(name, 6)); // deterministic
      }
    });

    test('empty branch / zero palette fold to 0 without throwing', () {
      expect(branchColorIndex('', 6), 0);
      expect(branchColorIndex('main', 0), 0);
    });
  });

  test('laneBranches carry the branch each lane belongs to (fork + merge)', () {
    // main: m1 ── m2 ─────── m3 (merge)
    //         └── f1 ── f2 ──┘  (feature)
    final rows = buildGraphRows([
      _c('m3', ['m2', 'f2'], hoursAgo: 0, branch: 'main'),
      _c('f2', ['f1'], hoursAgo: 1, branch: 'feature'),
      _c('m2', ['m1'], hoursAgo: 2, branch: 'main'),
      _c('f1', ['m1'], hoursAgo: 3, branch: 'feature'),
      _c('m1', [], hoursAgo: 4, branch: 'main'),
    ]);
    final by = {for (final r in rows) r.commit.sha: r};

    // The node's own lane carries its own branch.
    expect(by['m3']!.laneBranches[by['m3']!.lane], 'main');
    expect(by['f2']!.laneBranches[by['f2']!.lane], 'feature');

    // While the feature chain is on screen, lane 1 (feature) passes through
    // m2's row — and the painter should see it as 'feature', not 'main'.
    expect(by['m2']!.passThrough[1], isTrue);
    expect(by['m2']!.laneBranches[1], 'feature');

    // Symmetrically, main (lane 0) passes through f2's row.
    expect(by['f2']!.passThrough[0], isTrue);
    expect(by['f2']!.laneBranches[0], 'main');
  });

  test('linear history stays in one lane', () {
    final rows = buildGraphRows([
      _c('c3', ['c2'], hoursAgo: 0),
      _c('c2', ['c1'], hoursAgo: 1),
      _c('c1', [], hoursAgo: 2),
    ]);

    expect(rows.map((r) => r.lane), everyElement(0));
    // Tip has no child above; root has no parent below.
    expect(rows.first.topStem, isFalse);
    expect(rows.first.bottomStem, isTrue);
    expect(rows.last.bottomStem, isFalse);
    expect(rows.every((r) => r.intoNode.isEmpty && r.outOfNode.isEmpty), isTrue);
  });

  test('fork + merge opens a second lane and collapses it back', () {
    // main: m1 ── m2 ─────── m3 (merge)
    //         └── f1 ── f2 ──┘
    final rows = buildGraphRows([
      _c('m3', ['m2', 'f2'], hoursAgo: 0),
      _c('f2', ['f1'], hoursAgo: 1),
      _c('m2', ['m1'], hoursAgo: 2),
      _c('f1', ['m1'], hoursAgo: 3),
      _c('m1', [], hoursAgo: 4),
    ]);
    final by = {for (final r in rows) r.commit.sha: r};

    // Merge node sits in lane 0 and forks lane 1 toward its second parent.
    expect(by['m3']!.lane, 0);
    expect(by['m3']!.outOfNode, [1]);

    // The feature chain lives in lane 1; main continues in lane 0.
    expect(by['f2']!.lane, 1);
    expect(by['f1']!.lane, 1);
    expect(by['m2']!.lane, 0);

    // While the feature chain is on screen, lane 0/1 pass through each
    // other's rows.
    expect(by['f2']!.passThrough[0], isTrue);
    expect(by['m2']!.passThrough[1], isTrue);

    // Both lanes expect m1 — the extra lane converges into it and frees.
    expect(by['m1']!.lane, 0);
    expect(by['m1']!.intoNode, [1]);
  });

  test('first parent outside the window keeps the line running off-screen', () {
    final rows = buildGraphRows([
      _c('c2', ['c1'], hoursAgo: 0),
      _c('c1', ['off-window'], hoursAgo: 1),
    ]);
    // The oldest visible commit still has a bottom stem (history continues).
    expect(rows.last.bottomStem, isTrue);
  });

  test('octopus merge fans out one lane per extra parent', () {
    final rows = buildGraphRows([
      _c('o', ['a', 'b', 'c'], hoursAgo: 0),
      _c('a', [], hoursAgo: 1),
      _c('b', [], hoursAgo: 2),
      _c('c', [], hoursAgo: 3),
    ]);
    final by = {for (final r in rows) r.commit.sha: r};

    expect(by['o']!.lane, 0);
    expect(by['o']!.outOfNode, [1, 2]); // b and c get their own lanes
    expect(by['a']!.lane, 0);
    expect(by['b']!.lane, 1);
    expect(by['c']!.lane, 2);
  });

  test('freed lanes are reused by later tips (graph stays narrow)', () {
    // Two short-lived branches, one after the other — the second should
    // reuse lane 1 freed by the first.
    final rows = buildGraphRows([
      _c('m4', ['m3', 'g1'], hoursAgo: 0),
      _c('g1', ['m3'], hoursAgo: 1),
      _c('m3', ['m2', 'f1'], hoursAgo: 2),
      _c('f1', ['m2'], hoursAgo: 3),
      _c('m2', [], hoursAgo: 4),
    ]);
    final by = {for (final r in rows) r.commit.sha: r};

    expect(by['g1']!.lane, 1);
    expect(by['f1']!.lane, 1); // reused, not lane 2
    expect(rows.map((r) => r.laneSpan).reduce((a, b) => a > b ? a : b), 2);
  });

  test('CommitGraph.fromMap parses the callable payload defensively', () {
    final graph = CommitGraph.fromMap({
      'commits': [
        {
          'sha': 'abc',
          'message': 'Merge pull request #5 from x/y',
          'committedAt': '2026-06-04T01:02:03Z',
          'parents': ['p1', 'p2'],
          'author': {
            'login': 'alice-dev',
            'name': 'Alice',
            'avatarUrl': 'https://a/img.png',
          },
          'primaryBranch': 'main',
          'isMerge': true,
          'prNumber': 5,
        },
        // Degenerate entry: every field missing → defaults, no throw.
        <String, dynamic>{},
      ],
      'branches': [
        {'name': 'main', 'tipSha': 'abc', 'isDefault': true},
      ],
      'truncated': true,
    });

    expect(graph.commits, hasLength(2));
    final c = graph.commits.first;
    expect(c.sha, 'abc');
    expect(c.parents, ['p1', 'p2']);
    expect(c.authorLogin, 'alice-dev');
    expect(c.avatarUrl, 'https://a/img.png');
    expect(c.prNumber, 5);
    expect(graph.branches.single.isDefault, isTrue);
    expect(graph.truncated, isTrue);
    expect(graph.tipLabels['abc'], 'main');
  });
}
