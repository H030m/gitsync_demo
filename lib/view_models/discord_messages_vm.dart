import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/discord_digest.dart';
import '../models/discord_message.dart';
import '../models/repo.dart';
import '../repositories/discord_digest_repo.dart';
import '../repositories/discord_fetch_repo.dart';
import '../repositories/discord_message_repo.dart';
import '../repositories/repo_repo.dart';
import '../services/functions_service.dart';
import 'agent_trace_mixin.dart';

/// Drives the Daily page's Discord tab: streams messages + the visible window's
/// digests, and owns the Discord half of the shared Refresh ([refreshWindow]).
///
/// State model (post-06-05): the shared AppBar range SET calls [setRange] —
/// which persists the backfill range (now ADDITIVE-ONLY, D1; nothing is
/// deleted) AND mirrors into the display view range for instant feedback. The
/// shared range CLEAR calls [clearViewRange] (display only, no callable). The
/// visible window precedence stays view → saved → today.
class DiscordMessagesViewModel with ChangeNotifier, AgentTraceMixin {
  DiscordMessagesViewModel({
    required String repoId,
    DateTime? date,
    DiscordMessageRepository? messageRepository,
    DiscordDigestRepository? digestRepository,
    RepoRepository? repoRepository,
    DiscordFetchRepository? fetchRepository,
    FunctionsService? functionsService,
  })  : _repoId = repoId,
        _date = date ?? DateTime.now(),
        _repo = messageRepository ?? DiscordMessageRepository(),
        _digestRepo = digestRepository ?? DiscordDigestRepository(),
        _repoRepo = repoRepository ?? RepoRepository(),
        _fetchRepo = fetchRepository ?? DiscordFetchRepository(),
        _functions = functionsService ?? FunctionsService() {
    _sub = _repo.streamRecent(_repoId).listen((messages) {
      _messages = messages;
      _loading = false;
      notifyListeners();
    });
    // The digest cards cover EVERY day in the visible window (view range →
    // saved backfill range → today), defaulting to today until the repo doc
    // (and its range) arrives.
    _subscribeDigests();
    _repoSub = _repoRepo.streamRepo(_repoId).listen(_onRepo);
  }

  final String _repoId;
  final DateTime _date;
  final DiscordMessageRepository _repo;
  final DiscordDigestRepository _digestRepo;
  final RepoRepository _repoRepo;
  final DiscordFetchRepository _fetchRepo;
  final FunctionsService _functions;
  StreamSubscription<List<DiscordMessage>>? _sub;
  StreamSubscription<List<DiscordDigest>>? _digestSub;
  StreamSubscription<Repo?>? _repoSub;
  StreamSubscription<String?>? _fetchSub;
  Timer? _fetchTimeout;

  // Terminal fetch-request statuses: the bot round-trip is finished.
  static const _terminalStatuses = {'done', 'ingested', 'digest_failed'};

  // The window the digest range stream is currently subscribed to (inclusive
  // YYYY-MM-DD keys). Follows the visible window (view → saved → today).
  String? _digestWindowStart;
  String? _digestWindowEnd;

  DateTime? _rangeStart;
  DateTime? _rangeEnd;

  /// Range start parsed from the repo doc's `discordStartDate`, null if unset.
  DateTime? get rangeStart => _rangeStart;

  /// Range end parsed from the repo doc's `discordEndDate`, null if unset.
  DateTime? get rangeEnd => _rangeEnd;

  // Display view range (the shared AppBar scope). Re-points which days' digests
  // SHOW. Since `setDiscordRange` is now additive-only (D1), the shared range
  // SET path persists via [setRange] AND mirrors into this view range for
  // instant display (no waiting on the repo-doc round-trip). Null when no shared
  // scope is active (falls back to the saved range / today). State model: the
  // shared range SET → [setRange] (persist + display); CLEAR → [clearViewRange]
  // (display only, no callable).
  DateTime? _viewStart;
  DateTime? _viewEnd;

  /// View-range start (the shared scope), null when not scoped.
  DateTime? get viewStart => _viewStart;

  /// View-range end (the shared scope), null when not scoped.
  DateTime? get viewEnd => _viewEnd;

  List<DiscordMessage> _messages = [];
  List<DiscordMessage> get messages => _messages;

  // Every digest in the visible window, newest day first. Days without a digest
  // doc are simply absent.
  List<DiscordDigest> _digests = [];
  List<DiscordDigest> get digests => _digests;

  /// Backward-compat: the newest digest in the window (or null when empty).
  DiscordDigest? get digest => _digests.isEmpty ? null : _digests.first;

  bool _loading = true;
  bool get loading => _loading;

  bool _refreshing = false;
  bool get refreshing => _refreshing;

  // When the last refresh round-trip completed (bot finished). Null until the
  // first one finishes.
  DateTime? _lastUpdatedAt;
  DateTime? get lastUpdatedAt => _lastUpdatedAt;

  // One-shot flag set when a refresh just finished, so the UI can show a single
  // "Updated" toast. Cleared via [acknowledgeUpdated].
  bool _justUpdated = false;
  bool get justUpdated => _justUpdated;

  // Consumes the one-shot [justUpdated] flag after the UI has shown its toast.
  void acknowledgeUpdated() {
    _justUpdated = false;
  }

  bool _settingRange = false;
  bool get settingRange => _settingRange;

  // Per-date in-flight flags so each card spins independently.
  final Set<String> _editingDates = {};
  bool isEditingDigest(String date) => _editingDates.contains(date);

  final Set<String> _togglingDates = {};
  bool isTogglingLock(String date) => _togglingDates.contains(date);

  String? _digestError;
  String? get digestError => _digestError;

  String _keyOf(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-'
      '${d.month.toString().padLeft(2, '0')}-'
      '${d.day.toString().padLeft(2, '0')}';

  // Parses a YYYY-MM-DD key into a local DateTime, null if absent/unparseable.
  DateTime? _parseKey(String? key) {
    if (key == null || key.isEmpty) return null;
    return DateTime.tryParse(key);
  }

  // (Re)subscribes the digest range stream to the current visible window.
  void _subscribeDigests() {
    final startKey = _keyOf(_windowStart);
    final endKey = _keyOf(_windowEnd);
    _digestWindowStart = startKey;
    _digestWindowEnd = endKey;
    _digestSub?.cancel();
    _digestSub = _digestRepo
        .streamDigestsInRange(_repoId, startKey, endKey)
        .listen((digests) {
      _digests = digests;
      notifyListeners();
    });
  }

  // Reacts to repo doc changes: updates the saved range and, when the resolved
  // visible window changes, re-points the digest range stream.
  void _onRepo(Repo? repo) {
    _rangeStart = _parseKey(repo?.discordStartDate);
    _rangeEnd = _parseKey(repo?.discordEndDate);
    _repointDigests();
    notifyListeners();
  }

  // The visible window the digest cards cover, by precedence: the display
  // view-range → the saved backfill range → today.
  DateTime get _windowStart => _viewStart ?? _rangeStart ?? _date;
  DateTime get _windowEnd => _viewEnd ?? _rangeEnd ?? _date;

  /// The digest day the refresh / backfill defaults to: the window's end.
  String get _digestDateKey => _keyOf(_windowEnd);

  // Re-points the digest range stream if the resolved window changed.
  void _repointDigests() {
    final startKey = _keyOf(_windowStart);
    final endKey = _keyOf(_windowEnd);
    if (startKey != _digestWindowStart || endKey != _digestWindowEnd) {
      _subscribeDigests();
    }
  }

  // Display-only: re-points what the Discord tab SHOWS (the digest day) to the
  // shared view range. Never calls the `setDiscordRange` callable — purely a
  // view scope (storage is additive-only, D1). Pairs with [clearViewRange].
  void setViewRange(DateTime start, DateTime end) {
    _viewStart = start;
    _viewEnd = end;
    _repointDigests();
    notifyListeners();
  }

  // Clears the display-only view range; the digest day falls back to the saved
  // backfill range end (or today). No callable (storage is additive-only, D1).
  void clearViewRange() {
    _viewStart = null;
    _viewEnd = null;
    _repointDigests();
    notifyListeners();
  }

  // Triggers an on-demand Discord backfill for the range's end date (latest
  // day). The bot ingests the messages and the backend writes a digest. We keep
  // [refreshing] true until the fetch-request doc reaches a terminal status, so
  // the spinner reflects the real round-trip rather than just the enqueue.
  Future<void> refresh() async {
    if (_refreshing) return;
    _refreshing = true;
    notifyListeners();

    String requestId;
    try {
      requestId = await _functions.requestDiscordFetch(
        repoId: _repoId,
        date: _digestDateKey,
      );
    } catch (_) {
      _refreshing = false;
      notifyListeners();
      return;
    }

    // Watch the request status; finish when it reaches a terminal state.
    _fetchSub?.cancel();
    _fetchSub =
        _fetchRepo.streamStatus(_repoId, requestId).listen((status) {
      if (status != null && _terminalStatuses.contains(status)) {
        _finishRefresh();
      }
    });

    // Safety net: stop spinning even if no terminal status ever arrives.
    _fetchTimeout?.cancel();
    _fetchTimeout = Timer(const Duration(seconds: 120), () {
      if (_refreshing) _finishRefresh();
    });
  }

  // Marks a refresh as complete: stops the spinner, records the time, raises
  // the one-shot "updated" flag, and tears down the status watch.
  void _finishRefresh() {
    _fetchSub?.cancel();
    _fetchSub = null;
    _fetchTimeout?.cancel();
    _fetchTimeout = null;
    if (!_refreshing) return;
    _refreshing = false;
    _lastUpdatedAt = DateTime.now();
    _justUpdated = true;
    notifyListeners();
  }

  // Sets the backfill date range for this repo's Discord channels. Now
  // additive-only (D1): the bot re-pulls the window and dedups by messageId; no
  // out-of-window docs are deleted. Mirrors the range into the display view
  // range immediately (so the digest panel re-points without waiting on the
  // repo-doc round-trip); the persisted range also arrives via the repo stream.
  Future<void> setRange(DateTime start, DateTime end) async {
    if (_settingRange) return;
    _viewStart = start;
    _viewEnd = end;
    _repointDigests();
    _settingRange = true;
    notifyListeners();
    try {
      await _functions.setDiscordRange(
        repoId: _repoId,
        startDate: _keyOf(start),
        endDate: _keyOf(end),
      );
    } finally {
      _settingRange = false;
      notifyListeners();
    }
  }

  // The Discord half of the shared AppBar Refresh (D3): re-requests an on-demand
  // backfill for EVERY day in the visible window (view → saved → today), oldest
  // first, capped at 31 days. The bot dedups already-ingested messages, so this
  // only fills in missing days. Sequential awaits keep it simple; [refreshing]
  // stays true for the whole sweep.
  Future<void> refreshWindow() async {
    if (_refreshing) return;
    _refreshing = true;
    notifyListeners();

    // Normalize to whole days, oldest..newest, capped at 31.
    var start = DateTime(_windowStart.year, _windowStart.month, _windowStart.day);
    var end = DateTime(_windowEnd.year, _windowEnd.month, _windowEnd.day);
    if (end.isBefore(start)) {
      final tmp = start;
      start = end;
      end = tmp;
    }
    final days = <DateTime>[];
    for (var d = start;
        !d.isAfter(end) && days.length < 31;
        d = d.add(const Duration(days: 1))) {
      days.add(d);
    }

    try {
      for (final day in days) {
        try {
          await _functions.requestDiscordFetch(
            repoId: _repoId,
            date: _keyOf(day),
          );
        } catch (_) {
          // Best-effort per day — one failed enqueue shouldn't abort the sweep.
        }
      }
    } finally {
      _refreshing = false;
      _lastUpdatedAt = DateTime.now();
      _justUpdated = true;
      notifyListeners();
    }
  }

  // Asks the AI to adjust the digest for [date] (the tapped card's day). The
  // updated markdown arrives via the digest stream, so we don't set it locally.
  Future<void> editDigest(String date, String instruction) async {
    if (_editingDates.contains(date) || instruction.trim().isEmpty) return;
    final runId = newRunId('editdigest-');
    _editingDates.add(date);
    _digestError = null;
    notifyListeners();

    // Stream the agent's live "thinking" steps while the callable runs.
    beginTrace(_repoId, runId);

    try {
      await _functions.editDiscordDigest(
        repoId: _repoId,
        date: date,
        instruction: instruction.trim(),
        runId: runId,
      );
    } catch (e) {
      _digestError = '$e';
    } finally {
      endTrace();
      _editingDates.remove(date);
      notifyListeners();
    }
  }

  // Toggles the lock on [digest] (its own date). When locked, the backend won't
  // change it (auto-regen and AI edits are both refused).
  Future<void> toggleLock(DiscordDigest digest) async {
    final date = digest.date;
    if (_togglingDates.contains(date)) return;
    _togglingDates.add(date);
    _digestError = null;
    notifyListeners();
    try {
      await _functions.setDigestLock(
        repoId: _repoId,
        date: date,
        locked: !digest.locked,
      );
    } catch (e) {
      _digestError = '$e';
    } finally {
      _togglingDates.remove(date);
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    _digestSub?.cancel();
    _repoSub?.cancel();
    _fetchSub?.cancel();
    _fetchTimeout?.cancel();
    endTrace();
    super.dispose();
  }
}
