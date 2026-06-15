import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../models/agent_run.dart';
import '../models/ask_repo.dart';
import '../repositories/agent_run_repo.dart';
import '../services/functions_service.dart';

/// Drives the global "Ask GitSync" chat sheet: holds the transcript, calls the
/// `askRepo` callable (an agentic loop over the full read-only tool set), and —
/// while waiting — streams the agent tool-trace doc so the sheet can show live
/// progress steps. Mirrors [DailyBriefChatViewModel] (turns / sending / error /
/// ask() / newSession()), scoped to the whole repo (no date range).
class AskRepoViewModel with ChangeNotifier {
  AskRepoViewModel({
    required String repoId,
    FunctionsService? functionsService,
    AgentRunRepository? agentRunRepository,
  })  : _repoId = repoId,
        _functions = functionsService ?? FunctionsService(),
        _agentRuns = agentRunRepository ?? AgentRunRepository();

  final String _repoId;
  final FunctionsService _functions;
  final AgentRunRepository _agentRuns;

  final List<AskRepoTurn> _turns = [];
  List<AskRepoTurn> get turns => List.unmodifiable(_turns);

  bool _sending = false;
  bool get sending => _sending;

  String? _error;
  String? get error => _error;

  /// Live trace steps for the in-flight question (empty otherwise). Streamed
  /// from the agent-trace doc while [sending] is true.
  List<AgentStep> _liveSteps = const [];
  List<AgentStep> get liveSteps => List.unmodifiable(_liveSteps);

  StreamSubscription<AgentRun?>? _traceSub;

  static final _rng = Random();

  /// A unique, path-safe id for one run, generated BEFORE the callable so the UI
  /// can subscribe to the trace doc immediately (the callable carries it in).
  static String _newRunId() {
    final ts = DateTime.now().microsecondsSinceEpoch;
    // Use 1<<30 (web-safe), NOT 1<<32: on the web platform ints are JS numbers
    // and `1 << 32` overflows to 0, making Random.nextInt(0) throw RangeError.
    // 30 bits of randomness plus the microsecond timestamp is ample for a nonce.
    final nonce = _rng.nextInt(1 << 30).toRadixString(16);
    return 'run-$ts-$nonce';
  }

  /// Starts a fresh conversation: clears the transcript, error and live steps.
  /// No-ops while a question is in flight.
  void newSession() {
    if (_sending) return;
    if (_turns.isEmpty && _error == null && _liveSteps.isEmpty) return;
    _turns.clear();
    _error = null;
    _liveSteps = const [];
    notifyListeners();
  }

  /// Sends [question] to the AI. Appends a user turn immediately, subscribes to
  /// the run's trace doc to surface live steps, then appends an assistant turn
  /// (with sources) once the callable returns. No-ops on empty input or while a
  /// previous question is still in flight.
  Future<void> ask(String question) async {
    final trimmed = question.trim();
    if (trimmed.isEmpty || _sending) return;

    // Snapshot history (oldest first) BEFORE adding the new user turn.
    final history = List<AskRepoTurn>.from(_turns);

    final runId = _newRunId();
    _turns.add(AskRepoTurn(
      role: 'user',
      content: trimmed,
      createdAt: DateTime.now(),
    ));
    _sending = true;
    _error = null;
    _liveSteps = const [];
    notifyListeners();

    // Subscribe to the trace doc so steps appear while the callable runs.
    _traceSub = _agentRuns.watch(_repoId, runId).listen((run) {
      if (run == null) return;
      _liveSteps = run.steps;
      notifyListeners();
    });

    try {
      final reply = await _functions.askRepo(
        repoId: _repoId,
        question: trimmed,
        history: history,
        runId: runId,
      );
      _turns.add(AskRepoTurn(
        role: 'assistant',
        content: reply.answer,
        commitGroups: reply.commitGroups,
        discordSources: reply.snippets,
        createdAt: DateTime.now(),
      ));
    } catch (e) {
      _error = '$e';
      _turns.add(AskRepoTurn(
        role: 'assistant',
        content: '抱歉，我這次沒辦法回答，請稍後再試。',
        createdAt: DateTime.now(),
      ));
    } finally {
      // Fire-and-forget cancel: never block the turn's completion on tearing
      // down the trace stream (a closed stream's cancel can stay pending).
      unawaited(_traceSub?.cancel() ?? Future<void>.value());
      _traceSub = null;
      _sending = false;
      _liveSteps = const [];
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _traceSub?.cancel();
    super.dispose();
  }
}
