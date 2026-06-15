import 'package:cloud_firestore/cloud_firestore.dart';

import '../config/app_config.dart';
import '../models/agent_run.dart';
import 'fake/fake_agent_run_repo.dart';
import 'firestore_paths.dart';

/// Streams the agent tool-trace doc `repos/{repoId}/agentRuns/{runId}` so the UI
/// can render live progress steps WHILE the `askRepo` (or handoff) callable is
/// still running — the callable only resolves at the end, so the trace rides
/// this Firestore side-channel instead.
///
/// The runId is generated client-side and passed into the callable, so the UI
/// already holds it and can subscribe before the call returns.
abstract class AgentRunRepository {
  factory AgentRunRepository() => AppConfig.useFakeBackend
      ? FakeAgentRunRepository()
      : _LiveAgentRunRepository();

  /// Emits the run doc on every change (null until the backend creates it).
  Stream<AgentRun?> watch(String repoId, String runId);
}

// NOTE: `agentRuns` is written only by Cloud Functions; clients read-only.
class _LiveAgentRunRepository implements AgentRunRepository {
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  @override
  Stream<AgentRun?> watch(String repoId, String runId) {
    return _db
        .doc(FirestorePaths.agentRun(repoId, runId))
        .snapshots()
        .map((snap) {
      final data = snap.data();
      if (data == null) return null;
      return AgentRun.fromMap(data);
    });
  }
}
