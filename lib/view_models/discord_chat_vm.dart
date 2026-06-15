import 'package:flutter/foundation.dart';

import '../models/discord_chat.dart';
import '../services/functions_service.dart';
import 'agent_trace_mixin.dart';

/// Drives the Discord AI chat box: holds the conversation transcript and calls
/// the `discordChat` callable. Each assistant turn carries the messages the AI
/// surfaced, which the UI renders in a scrollable sources panel.
///
/// The chat is TIME-SCOPED (D2): Discord storage is additive-only, so messages
/// accumulate forever. Every question carries the shared window
/// ([_start]..[_end], inclusive days) so the AI only reads in-window messages /
/// digests. The window follows the same precedence as the rest of the Daily
/// page (view → saved → today); when unscoped no range is sent and the backend
/// treats it as unscoped.
class DiscordChatViewModel with ChangeNotifier, AgentTraceMixin {
  DiscordChatViewModel({
    required String repoId,
    FunctionsService? functionsService,
  })  : _repoId = repoId,
        _functions = functionsService ?? FunctionsService();

  final String _repoId;
  final FunctionsService _functions;

  final List<DiscordChatTurn> _turns = [];
  List<DiscordChatTurn> get turns => List.unmodifiable(_turns);

  bool _sending = false;
  bool get sending => _sending;

  String? _error;
  String? get error => _error;

  // The active time window the AI reads (inclusive days). Null when unscoped —
  // then no startDate/endDate is sent and the backend reads recent messages.
  DateTime? _start;
  DateTime? _end;

  static String _key(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-'
      '${d.month.toString().padLeft(2, '0')}-'
      '${d.day.toString().padLeft(2, '0')}';

  /// Scopes future questions to [start]..[end] (inclusive days). Wired from the
  /// Daily page's shared range; the transcript is preserved.
  void setRange(DateTime start, DateTime end) {
    _start = start;
    _end = end;
    notifyListeners();
  }

  /// Clears the time scope — future questions read recent messages (unscoped).
  void clearRange() {
    _start = null;
    _end = null;
    notifyListeners();
  }

  /// Starts a fresh conversation: clears the transcript and any error, keeping
  /// the current range scope. No-ops while a question is in flight.
  void newSession() {
    if (_sending) return;
    if (_turns.isEmpty && _error == null) return;
    _turns.clear();
    _error = null;
    notifyListeners();
  }

  /// Sends [question] to the AI. Appends a user turn immediately, then an
  /// assistant turn once the callable returns. No-ops on empty input or while a
  /// previous question is still in flight.
  Future<void> ask(String question) async {
    final trimmed = question.trim();
    if (trimmed.isEmpty || _sending) return;

    // Snapshot history (oldest first) BEFORE adding the new user turn.
    final history = List<DiscordChatTurn>.from(_turns);

    final runId = newRunId('chat-');
    _turns.add(DiscordChatTurn(
      role: 'user',
      content: trimmed,
      createdAt: DateTime.now(),
    ));
    _sending = true;
    _error = null;
    notifyListeners();

    // Stream the agent's live "thinking" steps while the callable runs.
    beginTrace(_repoId, runId);

    try {
      final reply = await _functions.discordChat(
        repoId: _repoId,
        question: trimmed,
        history: history,
        startDate: _start == null ? null : _key(_start!),
        endDate: _end == null ? null : _key(_end!),
        runId: runId,
      );
      _turns.add(DiscordChatTurn(
        role: 'assistant',
        content: reply.answer,
        snippets: reply.snippets,
        createdAt: DateTime.now(),
      ));
    } catch (e) {
      _error = '$e';
      _turns.add(DiscordChatTurn(
        role: 'assistant',
        content: '抱歉，我這次沒辦法回答，請稍後再試。',
        createdAt: DateTime.now(),
      ));
    } finally {
      endTrace();
      _sending = false;
      notifyListeners();
    }
  }

  @override
  void dispose() {
    endTrace();
    super.dispose();
  }
}
