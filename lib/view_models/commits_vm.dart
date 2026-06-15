import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/commit.dart';
import '../models/commit_graph.dart';
import '../repositories/commit_repo.dart';
import '../services/functions_service.dart';
import 'agent_trace_mixin.dart';

/// The Commits tab's two visualizations: real branch topology vs the flat,
/// filterable commit list. (`author` is the legacy enum name kept for callers;
/// it now backs the list view.)
enum CommitsViewMode { branch, author }

/// Streams the Commits tab's commit list (recent by default, or a user-picked
/// inclusive day range) and serves the tree map's "tap a commit → AI explains
/// the work" action, caching explanations per sha for the session.
class CommitsViewModel with ChangeNotifier, AgentTraceMixin {
  CommitsViewModel({
    required String repoId,
    CommitRepository? commitRepository,
    FunctionsService? functionsService,
  }) : _repoId = repoId,
       _repo = commitRepository ?? CommitRepository(),
       _functions = functionsService ?? FunctionsService() {
    _subscribe();
    _loadViewModePref();
    // The branch view is the default visualization — fetch its data up front.
    loadGraph();
  }

  static const _viewModePrefKey = 'commits_view_mode';

  final String _repoId;
  final CommitRepository _repo;
  final FunctionsService _functions;
  StreamSubscription<List<Commit>>? _sub;

  List<Commit> _commits = [];
  List<Commit> get commits => _commits;

  // ---- List filters (list view) --------------------------------------------

  final Set<String> _authorFilter = {};
  final Set<String> _branchFilter = {};
  String _keyword = '';

  /// Selected author logins (OR within the set). Empty → no author constraint.
  Set<String> get authorFilter => _authorFilter;

  /// Selected branch names (OR within the set). Empty → no branch constraint.
  /// Commits without a `branch` are grouped under 'main'.
  Set<String> get branchFilter => _branchFilter;

  /// Case-insensitive substring matched against the commit message.
  String get keyword => _keyword;

  bool get hasFilters =>
      _authorFilter.isNotEmpty ||
      _branchFilter.isNotEmpty ||
      _keyword.trim().isNotEmpty;

  /// Branch label for a commit, defaulting legacy (branch-less) docs to 'main'.
  static String branchLabel(Commit c) =>
      (c.branch == null || c.branch!.isEmpty) ? 'main' : c.branch!;

  /// Author logins present in the loaded commits (sorted, deduped).
  List<String> get availableAuthors {
    final set = <String>{
      for (final c in _commits)
        if (c.author.login.isNotEmpty) c.author.login,
    };
    final list = set.toList()..sort();
    return list;
  }

  /// Branch names present in the loaded commits (sorted, deduped; legacy docs
  /// fold into 'main').
  List<String> get availableBranches {
    final set = <String>{for (final c in _commits) branchLabel(c)};
    final list = set.toList()..sort();
    return list;
  }

  /// The loaded commits passed through the active filters: AND across the three
  /// dimensions, OR within each multi-select; keyword is a case-insensitive
  /// substring on the message.
  List<Commit> get filteredCommits {
    if (!hasFilters) return _commits;
    final kw = _keyword.trim().toLowerCase();
    return _commits.where((c) {
      if (_authorFilter.isNotEmpty &&
          !_authorFilter.contains(c.author.login)) {
        return false;
      }
      if (_branchFilter.isNotEmpty &&
          !_branchFilter.contains(branchLabel(c))) {
        return false;
      }
      if (kw.isNotEmpty && !c.message.toLowerCase().contains(kw)) {
        return false;
      }
      return true;
    }).toList();
  }

  void toggleAuthorFilter(String login) {
    if (!_authorFilter.add(login)) _authorFilter.remove(login);
    notifyListeners();
  }

  void toggleBranchFilter(String branch) {
    if (!_branchFilter.add(branch)) _branchFilter.remove(branch);
    notifyListeners();
  }

  void setKeyword(String value) {
    if (_keyword == value) return;
    _keyword = value;
    notifyListeners();
  }

  void clearFilters() {
    if (!hasFilters) return;
    _authorFilter.clear();
    _branchFilter.clear();
    _keyword = '';
    notifyListeners();
  }

  bool _loading = true;
  bool get loading => _loading;

  String? _streamError;

  /// Non-null when the commit stream itself failed (parse error, permission,
  /// missing index, offline). The tab shows an error state with a retry.
  String? get streamError => _streamError;

  // ---- Range filter --------------------------------------------------------

  DateTime? _rangeStart;
  DateTime? _rangeEnd;
  DateTime? get rangeStart => _rangeStart;
  DateTime? get rangeEnd => _rangeEnd;
  bool get hasRange => _rangeStart != null && _rangeEnd != null;

  void _subscribe() {
    _sub?.cancel();
    _loading = true;
    _streamError = null;
    final stream = hasRange
        ? _repo.streamRange(_repoId, _rangeStart!, _rangeEnd!)
        : _repo.streamRecent(_repoId, limit: 50);
    _sub = stream.listen(
      (commits) {
        _commits = commits;
        _loading = false;
        _streamError = null;
        notifyListeners();
      },
      onError: (Object e) {
        // Without this handler a stream error would leave `loading` true
        // forever (an eternal spinner). Surface it instead.
        _streamError = '$e';
        _loading = false;
        notifyListeners();
      },
    );
  }

  /// Re-subscribes after a stream error (the "Retry" button).
  void retry() {
    _subscribe();
    notifyListeners();
  }

  /// Filters the list to commits inside [start]..[end] (inclusive days).
  void setRange(DateTime start, DateTime end) {
    _rangeStart = start;
    _rangeEnd = end;
    _subscribe();
    _invalidateGraph();
    notifyListeners();
  }

  /// Back to the default "recent commits" stream.
  void clearRange() {
    _rangeStart = null;
    _rangeEnd = null;
    _subscribe();
    _invalidateGraph();
    notifyListeners();
  }

  // ---- Branch graph (real topology via getCommitGraph) ----------------------

  CommitsViewMode _viewMode = CommitsViewMode.branch;
  CommitsViewMode get viewMode => _viewMode;

  Future<void> _loadViewModePref() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final v = prefs.getString(_viewModePrefKey);
      if (v != null) {
        final mode = CommitsViewMode.values.where((e) => e.name == v);
        if (mode.isNotEmpty) setViewMode(mode.first);
      }
    } catch (_) {
      // No persistence available — keep the default.
    }
  }

  Future<void> _saveViewModePref(CommitsViewMode mode) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_viewModePrefKey, mode.name);
    } catch (_) {}
  }

  CommitGraph? _graph;
  CommitGraph? get graph => _graph;

  bool _graphLoading = false;
  bool get graphLoading => _graphLoading;

  String? _graphError;
  String? get graphError => _graphError;

  void setViewMode(CommitsViewMode mode) {
    if (_viewMode == mode) return;
    _viewMode = mode;
    if (mode == CommitsViewMode.branch && _graph == null && !_graphLoading) {
      loadGraph();
    }
    _saveViewModePref(mode);
    notifyListeners();
  }

  static String _ymd(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-'
      '${d.month.toString().padLeft(2, '0')}-'
      '${d.day.toString().padLeft(2, '0')}';

  /// Fetches the branch topology for the current range (or "recent"). The
  /// backend caches briefly, so re-toggling the view is cheap; pass [force] to
  /// bypass that cache (pull-to-refresh / the refresh button). On a refresh the
  /// existing graph stays visible — `_graph` is not cleared — so the view only
  /// shows the full-screen spinner on the very first load (`graph == null`).
  Future<void> loadGraph({bool force = false}) async {
    _graphLoading = true;
    _graphError = null;
    notifyListeners();
    try {
      _graph = await _functions.getCommitGraph(
        repoId: _repoId,
        startDate: hasRange ? _ymd(_rangeStart!) : null,
        endDate: hasRange ? _ymd(_rangeEnd!) : null,
        force: force,
      );
    } catch (e) {
      _graphError = '$e';
    } finally {
      _graphLoading = false;
      notifyListeners();
    }
  }

  // A range change makes the cached graph stale; refetch eagerly only when
  // the branch view is the one on screen.
  void _invalidateGraph() {
    _graph = null;
    _graphError = null;
    if (_viewMode == CommitsViewMode.branch) loadGraph();
  }

  // ---- AI work explanations (tree map tap) ---------------------------------

  final Map<String, String> _explanations = {};
  final Set<String> _explaining = {};

  /// The cached AI explanation for [sha], if one was fetched this session.
  String? explanationFor(String sha) => _explanations[sha];

  bool isExplaining(String sha) => _explaining.contains(sha);

  String? _explainError;
  String? get explainError => _explainError;

  /// Fetches (or re-fetches with [force]) the AI work summary for [sha]. The
  /// backend additionally caches on the commit doc, so repeat calls are cheap.
  /// [language] (W6) is the English language NAME for the app locale; sent on a
  /// recompute ([force] = true) so the summary returns in the user's language.
  Future<void> explain(String sha, {bool force = false, String? language}) async {
    if (_explaining.contains(sha)) return;
    if (!force && _explanations.containsKey(sha)) return;
    final runId = newRunId('explain-');
    _explaining.add(sha);
    _explainError = null;
    notifyListeners();

    // Stream the agent's live "thinking" steps while the callable runs.
    beginTrace(_repoId, runId);

    try {
      final markdown = await _functions.explainCommit(
        repoId: _repoId,
        sha: sha,
        force: force,
        language: language,
        runId: runId,
      );
      _explanations[sha] = markdown;
    } catch (e) {
      _explainError = '$e';
    } finally {
      endTrace();
      _explaining.remove(sha);
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    endTrace();
    super.dispose();
  }
}
