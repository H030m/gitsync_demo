// Pure dependency-graph helpers for interactive editing (no Flutter / Firestore),
// so they can be unit-tested in isolation. The graph is modelled as
// `deps[taskId] = [prerequisite ids]` (mirrors `Task.dependsOn`; an edge points
// prerequisite → dependent).

/// Would adding "[dependent] depends on [prereq]" create a cycle?
///
/// A cycle appears iff [prereq] already (transitively) depends on [dependent] —
/// i.e. following `dependsOn` edges from [prereq] can reach [dependent]. Adding
/// the reverse edge would then close a loop. Self-links are always cycles.
bool wouldCreateCycle(
  Map<String, List<String>> deps,
  String dependent,
  String prereq,
) {
  if (dependent == prereq) return true;
  final seen = <String>{};
  final stack = <String>[prereq];
  while (stack.isNotEmpty) {
    final node = stack.removeLast();
    if (node == dependent) return true;
    if (!seen.add(node)) continue;
    for (final p in deps[node] ?? const <String>[]) {
      stack.add(p);
    }
  }
  return false;
}

/// New `dependsOn` lists for the tasks affected by deleting [deleted], bridging
/// its prerequisites onto its dependents: for every task `c` that depended on
/// [deleted], `c.dependsOn = (c.dependsOn − deleted) ∪ deleted.dependsOn`
/// (deduped, never including `c` itself). Contracting a node of a DAG keeps it
/// acyclic, so no extra cycle check is needed. Only changed tasks are returned.
Map<String, List<String>> bridgeOnDelete(
  Map<String, List<String>> deps,
  String deleted,
) {
  final prereqs = deps[deleted] ?? const <String>[];
  final changes = <String, List<String>>{};
  for (final entry in deps.entries) {
    final taskId = entry.key;
    if (taskId == deleted) continue;
    if (!entry.value.contains(deleted)) continue;
    final next = <String>[];
    for (final p in entry.value) {
      if (p == deleted) continue;
      if (!next.contains(p)) next.add(p);
    }
    for (final p in prereqs) {
      if (p == taskId) continue; // never self-depend
      if (!next.contains(p)) next.add(p);
    }
    changes[taskId] = next;
  }
  return changes;
}
