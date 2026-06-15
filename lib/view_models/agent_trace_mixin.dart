import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../models/agent_run.dart';
import '../repositories/agent_run_repo.dart';

/// Shared live agent-trace plumbing for ViewModels that drive an agentic
/// callable. It generates a flow-prefixed runId, streams the `agentRuns` doc the
/// backend writes WHILE the callable runs, and exposes the steps as [liveSteps]
/// so the UI can render Claude-Code-style "thinking" lines (reading code,
/// searching Discord, writing…) instead of a bare spinner.
///
/// Mirrors the wiring [AskRepoViewModel] does inline; the runId is generated
/// client-side and passed into the callable, so the UI subscribes before the
/// call returns. The repo is created lazily on first use (so a non-Firebase
/// test/fake build never touches Firestore until a trace actually starts) and
/// can be swapped for a fake via [agentRunRepository].
mixin AgentTraceMixin on ChangeNotifier {
  AgentRunRepository? _agentRunsField;
  AgentRunRepository get _agentRuns =>
      _agentRunsField ??= AgentRunRepository();

  /// Test seam: inject a fake trace repo before driving the flow.
  @visibleForTesting
  set agentRunRepository(AgentRunRepository repo) => _agentRunsField = repo;

  List<AgentStep> _liveSteps = const [];

  /// Live trace steps for the in-flight run (empty when idle).
  List<AgentStep> get liveSteps => List.unmodifiable(_liveSteps);

  StreamSubscription<AgentRun?>? _traceSub;
  static final _rng = Random();

  /// A unique, path-safe run id prefixed by [flowPrefix] (e.g. `'chat-'`) — the
  /// hook the fake trace repo uses to pick flow-matching demo steps. Generated
  /// BEFORE the callable so the UI can subscribe immediately.
  String newRunId(String flowPrefix) {
    final ts = DateTime.now().microsecondsSinceEpoch;
    // 30 bits (web-safe; 1<<32 overflows to 0 on JS) + microsecond ts ≈ unique.
    final nonce = _rng.nextInt(1 << 30).toRadixString(16);
    return '$flowPrefix$ts-$nonce';
  }

  /// Subscribes to the trace doc [runId] and pushes its steps into [liveSteps].
  /// Cancels any prior subscription first. Call [endTrace] when the callable
  /// settles.
  void beginTrace(String repoId, String runId) {
    unawaited(_traceSub?.cancel() ?? Future<void>.value());
    _liveSteps = const [];
    _traceSub = _agentRuns.watch(repoId, runId).listen((run) {
      if (run == null) return;
      _liveSteps = run.steps;
      notifyListeners();
    });
  }

  /// Tears down the trace subscription and clears [liveSteps]. Safe to call more
  /// than once. Does NOT notify — callers fold it into their own notify in the
  /// `finally` block that ends the call.
  void endTrace() {
    unawaited(_traceSub?.cancel() ?? Future<void>.value());
    _traceSub = null;
    _liveSteps = const [];
  }
}
