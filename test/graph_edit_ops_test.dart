import 'package:flutter_test/flutter_test.dart';
import 'package:gitsync/view_models/graph_edit_ops.dart';

void main() {
  group('wouldCreateCycle', () {
    test('self-link is always a cycle', () {
      expect(wouldCreateCycle({}, 'A', 'A'), isTrue);
    });

    test('adding the reverse of an existing chain creates a cycle', () {
      // A depends on B; adding "B depends on A" closes a loop.
      final deps = {
        'A': ['B'],
        'B': <String>[],
      };
      expect(wouldCreateCycle(deps, 'B', 'A'), isTrue);
    });

    test('transitive reverse is a cycle', () {
      // A→B→C (A depends on B, B depends on C). Adding "C depends on A" loops.
      final deps = {
        'A': ['B'],
        'B': ['C'],
        'C': <String>[],
      };
      expect(wouldCreateCycle(deps, 'C', 'A'), isTrue);
    });

    test('a safe new edge is allowed', () {
      final deps = {
        'A': ['B'],
        'B': <String>[],
        'C': <String>[],
      };
      // C depends on A — no path from A back to C.
      expect(wouldCreateCycle(deps, 'C', 'A'), isFalse);
    });
  });

  group('bridgeOnDelete', () {
    test('bridges prerequisites onto dependents', () {
      // A ← B ← C  (B depends on A, C depends on B). Delete B ⇒ C depends on A.
      final deps = {
        'A': <String>[],
        'B': ['A'],
        'C': ['B'],
      };
      expect(bridgeOnDelete(deps, 'B'), {
        'C': ['A'],
      });
    });

    test('fans the bridge out to every dependent and dedups', () {
      final deps = {
        'A': <String>[],
        'B': ['A'],
        'C': ['B', 'A'], // already depends on A too
        'D': ['B'],
      };
      final changes = bridgeOnDelete(deps, 'B');
      expect(changes['C'], ['A']); // (C.deps - B) ∪ [A] deduped
      expect(changes['D'], ['A']);
    });

    test('never makes a task depend on itself', () {
      // Pathological: B depends on A, and A depends on B's dependent... keep it
      // simple — deleting a node must not inject a self-dep.
      final deps = {
        'A': <String>[],
        'B': ['A'],
        'A2': ['B'],
      };
      final changes = bridgeOnDelete(deps, 'B');
      expect(changes['A2'], ['A']);
      expect(changes.containsKey('B'), isFalse);
    });

    test('no dependents → no changes', () {
      final deps = {
        'A': <String>[],
        'B': ['A'],
      };
      expect(bridgeOnDelete(deps, 'B'), isEmpty);
    });
  });
}
