import 'package:flutter/foundation.dart';

import '../models/daily_brief.dart';
import '../services/functions_service.dart';

/// Drives the Summary tab's "ask AI about today" chat: holds the transcript and
/// calls the `dailyBrief` callable (an agentic loop over the day's commits /
/// tasks / Discord digest). Each assistant turn carries the commits the AI
/// surfaced, rendered as sources under the answer. Mirrors
/// [DiscordChatViewModel] but is scoped to a single report date.
class DailyBriefChatViewModel with ChangeNotifier {
  DailyBriefChatViewModel({
    required String repoId,
    DateTime? date,
    FunctionsService? functionsService,
  })  : _repoId = repoId,
        _start = date ?? DateTime.now(),
        _end = date ?? DateTime.now(),
        _functions = functionsService ?? FunctionsService();

  final String _repoId;
  DateTime _start;
  DateTime _end;
  final FunctionsService _functions;

  final List<DailyBriefTurn> _turns = [];
  List<DailyBriefTurn> get turns => List.unmodifiable(_turns);

  bool _sending = false;
  bool get sending => _sending;

  String? _error;
  String? get error => _error;

  static String _key(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-'
      '${d.month.toString().padLeft(2, '0')}-'
      '${d.day.toString().padLeft(2, '0')}';

  /// Re-scopes future questions to [start]..[end] (inclusive days). Kept in
  /// sync with the report VM's range by the Summary tab's range picker. The
  /// transcript is preserved — only the scope of new questions changes.
  void setRange(DateTime start, DateTime end) {
    _start = start;
    _end = end;
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
    final history = List<DailyBriefTurn>.from(_turns);

    _turns.add(DailyBriefTurn(
      role: 'user',
      content: trimmed,
      createdAt: DateTime.now(),
    ));
    _sending = true;
    _error = null;
    notifyListeners();

    try {
      final reply = await _functions.dailyBrief(
        repoId: _repoId,
        date: _key(_start),
        endDate: _key(_end) == _key(_start) ? null : _key(_end),
        question: trimmed,
        history: history,
      );
      _turns.add(DailyBriefTurn(
        role: 'assistant',
        content: reply.answer,
        sources: reply.sources,
        createdAt: DateTime.now(),
      ));
    } catch (e) {
      _error = '$e';
      _turns.add(DailyBriefTurn(
        role: 'assistant',
        content: '抱歉，我這次沒辦法回答，請稍後再試。',
        createdAt: DateTime.now(),
      ));
    } finally {
      _sending = false;
      notifyListeners();
    }
  }
}
