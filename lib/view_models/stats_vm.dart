import 'package:flutter/foundation.dart';

import '../models/commit.dart';
import '../models/member.dart';
import '../models/task.dart';
import '../repositories/commit_repo.dart';
import '../repositories/user_repo.dart';
import '../services/functions_service.dart';
import 'members_vm.dart';
import 'tasks_board_vm.dart';

/// One member's share of the team's completed (done) tasks.
@immutable
class Contribution {
  const Contribution({
    required this.assigneeId,
    required this.label,
    required this.doneCount,
    required this.pct,
  });

  final String assigneeId;

  /// Display label for the member — the roster has no human-readable name
  /// field today, so this falls back to the raw assigneeId.
  final String label;

  /// Number of done tasks assigned to this member.
  final int doneCount;

  /// This member's share of ALL done tasks, 0..100 (rounded). When no task is
  /// done across the team every share is 0.
  final int pct;
}

/// A canonical commit author identity, merging the login-keyed and name-keyed
/// buckets a single human can split into (GraphQL-backfilled commits can lack
/// `author.login`). See [StatsViewModel.buildAuthorGroups].
@immutable
class AuthorGroup {
  const AuthorGroup({
    required this.key,
    required this.label,
    required this.commitCount,
    required this.names,
    required this.login,
    required this.pct,
  });

  /// Stable bucket key: lowercase login when resolvable, else normalized name.
  final String key;

  /// Display label: the canonical GitHub login (original casing) when known,
  /// else the (raw) git name.
  final String label;

  /// Number of commits in this bucket.
  final int commitCount;

  /// Distinct raw git names seen for this author (order of first appearance).
  final List<String> names;

  /// The canonical GitHub login (original casing) when known, else null.
  final String? login;

  /// This author's share of ALL commits, 0..100 (rounded).
  final int pct;
}

// Derived statistics view (StatsViewPage) built from TasksBoardViewModel and
// MembersViewModel, plus an all-history commit fetch and async member-name
// resolution. Plug the two upstream VMs in via ChangeNotifierProxyProvider2.
//
// Derivations:
//   * `contributions`       — per-member share of COMPLETED tasks (task basis,
//                             貢獻度 tab's 任務 toggle).
//   * `authorGroups`        — canonical commit authors over ALL history, one
//                             entry per human (login/name buckets merged).
//   * `commitContributions` — per-author share of ALL commits, derived from
//                             `authorGroups` (貢獻度 tab's commit toggle).
//
// The 進度表 tab lists `authorGroups` with an AI work summary per author,
// fetched on demand via [FunctionsService.summarizeAuthorWork] and cached here.
//
// Member labels resolve to GitHub names (users/{uid}.githubLogin, fallback
// .name, fallback uid) via UserRepository, cached so each uid is looked up once.
// Unassigned tasks are excluded from the task derivations.
class StatsViewModel with ChangeNotifier {
  StatsViewModel({
    required String repoId,
    CommitRepository? commitRepository,
    UserRepository? userRepository,
    FunctionsService? functionsService,
  })  : _repoId = repoId,
        _commitRepo = commitRepository ?? CommitRepository(),
        _userRepo = userRepository ?? UserRepository(),
        _functions = functionsService ?? FunctionsService() {
    _loadAllCommits();
  }

  final String _repoId;
  final CommitRepository _commitRepo;
  final UserRepository _userRepo;
  final FunctionsService _functions;

  TasksBoardViewModel? _tasksVm;
  MembersViewModel? _membersVm;

  // Guards against notifyListeners() firing after dispose — async callbacks
  // (e.g. _loadAllCommits, _resolveNames) can land after the VM is gone when
  // the user leaves the Stats tab mid-flight.
  bool _disposed = false;

  // ---- All-history commits (commit basis) ----------------------------------

  List<Commit> _allCommits = const [];

  bool _commitsLoading = true;

  /// True while the one-shot all-history commit fetch is in flight. The commit
  /// basis pie shows a spinner until this clears.
  bool get commitsLoading => _commitsLoading;

  List<AuthorGroup> _authorGroups = const [];

  /// Canonical commit authors over ALL history, one entry per human (login- and
  /// name-keyed buckets merged), sorted by commit count descending. Drives both
  /// the commit-basis pie and the 進度表 author list. See [buildAuthorGroups].
  List<AuthorGroup> get authorGroups => _authorGroups;

  /// Per-author share of ALL commits in the repo, derived from [authorGroups]
  /// (one slice per canonical human). Always reflects the full history, never
  /// the Daily page's loaded window.
  List<Contribution> get commitContributions => [
        for (final g in _authorGroups)
          Contribution(
            assigneeId: g.key,
            label: g.label,
            doneCount: g.commitCount,
            pct: g.pct,
          ),
      ];

  Future<void> _loadAllCommits() async {
    try {
      _allCommits = await _commitRepo.fetchAllCommits(_repoId);
    } catch (_) {
      // Tolerate a fetch failure: degrade to an empty list so the tab still
      // renders (the task basis is unaffected).
      _allCommits = const [];
    } finally {
      _commitsLoading = false;
      _authorGroups = buildAuthorGroups(_allCommits);
      _safeNotify();
    }
  }

  // ---- Member name resolution (githubLogin) --------------------------------

  // uid → resolved display label (githubLogin, fallback name, fallback uid).
  final Map<String, String> _names = {};
  // uids whose lookup is in flight, to avoid duplicate getUser calls.
  final Set<String> _resolving = {};

  /// Resolves each member's uid to a display label once, caching the result and
  /// notifying as each lookup lands so the labels refresh in place.
  void _resolveNames(List<Member> members) {
    for (final m in members) {
      final uid = m.userId;
      if (uid.isEmpty) continue;
      if (_names.containsKey(uid) || _resolving.contains(uid)) continue;
      _resolving.add(uid);
      _userRepo.getUser(uid).then((user) {
        _names[uid] = _labelFromUser(uid, user?.githubLogin, user?.name);
      }).catchError((_) {
        _names[uid] = uid; // tolerate lookup failure → raw uid
      }).whenComplete(() {
        _resolving.remove(uid);
        _recompute();
        _safeNotify();
      });
    }
  }

  static String _labelFromUser(String uid, String? githubLogin, String? name) {
    if (githubLogin != null && githubLogin.isNotEmpty) return githubLogin;
    if (name != null && name.isNotEmpty) return name;
    return uid;
  }

  List<Contribution> _contributions = const [];

  /// Per-member share of all done tasks, members with at least one done task
  /// first (by done count descending), then any remaining roster/assignee with
  /// zero done. See [computeContributions].
  List<Contribution> get contributions => _contributions;

  // Receives upstream updates from ChangeNotifierProxyProvider2.
  void updateFromUpstream({
    required TasksBoardViewModel tasks,
    required MembersViewModel members,
  }) {
    _tasksVm = tasks;
    _membersVm = members;
    _resolveNames(members.members);
    _recompute();
    _safeNotify();
  }

  void _recompute() {
    final tasks = _tasksVm?.tasks ?? const <Task>[];
    final members = _membersVm?.members ?? const <Member>[];

    _contributions = computeContributions(tasks, members, _names);
  }

  // ---- Per-author AI work summaries (進度表) --------------------------------

  // author key → cached markdown summary.
  final Map<String, String> _summaries = {};
  // author keys with a summarize call in flight.
  final Set<String> _summarizing = {};
  // author key → last error message (cleared on a fresh attempt).
  final Map<String, String> _summaryErrors = {};

  /// The cached AI work summary markdown for [key] (an [AuthorGroup.key]), or
  /// null if not yet loaded.
  String? authorSummary(String key) => _summaries[key];

  /// True while a [summarizeAuthorWork] call for [key] is in flight.
  bool isSummarizing(String key) => _summarizing.contains(key);

  /// The last error message for [key]'s summary attempt, or null.
  String? summaryError(String key) => _summaryErrors[key];

  /// Loads (or regenerates with [force]) the AI work summary for [g] via the
  /// callable, caching the markdown. Duplicate in-flight calls are ignored.
  Future<void> loadAuthorSummary(AuthorGroup g, {bool force = false}) async {
    if (_summarizing.contains(g.key)) return;
    if (!force && _summaries.containsKey(g.key)) return;

    _summarizing.add(g.key);
    _summaryErrors.remove(g.key);
    _safeNotify();

    try {
      final markdown = await _functions.summarizeAuthorWork(
        repoId: _repoId,
        login: (g.login != null && g.login!.isNotEmpty) ? g.login : null,
        names: g.names,
        force: force,
      );
      _summaries[g.key] = markdown;
    } catch (e) {
      _summaryErrors[g.key] = e.toString();
    } finally {
      _summarizing.remove(g.key);
      _safeNotify();
    }
  }

  /// Per-member share of all DONE tasks. Each member's pct = their done count /
  /// total done count across all assignees, rounded to an int (0..100). When no
  /// task is done team-wide every pct is 0 (zero-done edge). Only assignees with
  /// at least one done task get an entry; unassigned tasks are excluded. Sorted
  /// by done count descending, then by label. The [names] map (uid → resolved
  /// GitHub name) supplies labels; absent entries fall back to the raw id.
  /// Exposed for unit testing.
  static List<Contribution> computeContributions(
    List<Task> tasks,
    List<Member> members,
    Map<String, String> names,
  ) {
    final byId = {for (final m in members) m.userId: m};

    final done = <String, int>{};
    for (final t in tasks) {
      final id = t.assigneeId;
      if (id == null || id.isEmpty) continue;
      if (t.status != TaskStatus.done) continue;
      done.update(id, (v) => v + 1, ifAbsent: () => 1);
    }

    final totalDone = done.values.fold<int>(0, (a, b) => a + b);

    final list = [
      for (final entry in done.entries)
        Contribution(
          assigneeId: entry.key,
          label: _labelFor(entry.key, byId, names),
          doneCount: entry.value,
          pct: totalDone == 0
              ? 0
              : ((entry.value / totalDone) * 100).round(),
        ),
    ]..sort((a, b) {
        final byCount = b.doneCount.compareTo(a.doneCount);
        return byCount != 0 ? byCount : a.label.compareTo(b.label);
      });
    return list;
  }

  /// Canonicalizes commit authors into one [AuthorGroup] per human, merging the
  /// login-keyed and name-keyed buckets a single person can split into
  /// (GraphQL-backfilled commits can lack `author.login`).
  ///
  /// Pass 1 learns a name→login mapping from every commit carrying BOTH a
  /// non-empty login and name (nameKey = trimmed + lowercased name →
  /// lowercased login; the original login casing of the first sighting is kept
  /// for display).
  ///
  /// Pass 2 buckets every commit: by its login when present, else by the login
  /// learned for its name, else by its normalized name. The bucket key is the
  /// lowercase login when resolvable, else the normalized name. The display
  /// label is the canonical login (original casing) when known, else the raw
  /// name (falling back to 'unknown').
  ///
  /// pct = bucket commit count / total commit count, rounded (0..100). Sorted
  /// by commit count descending, then by label. Empty when there are no
  /// commits. Exposed for unit testing.
  static List<AuthorGroup> buildAuthorGroups(List<Commit> commits) {
    String norm(String s) => s.trim().toLowerCase();

    // Pass 1: learn nameKey → login (lowercase), keeping the first-seen
    // original login casing for display.
    final nameToLogin = <String, String>{}; // nameKey → login (lowercase)
    final loginDisplay = <String, String>{}; // login (lowercase) → orig casing
    for (final c in commits) {
      final login = c.author.login.trim();
      final name = c.author.name.trim();
      if (login.isEmpty) continue;
      final loginKey = login.toLowerCase();
      loginDisplay.putIfAbsent(loginKey, () => login);
      if (name.isNotEmpty) {
        nameToLogin.putIfAbsent(norm(name), () => loginKey);
      }
    }

    // Pass 2: bucket every commit.
    final counts = <String, int>{};
    final names = <String, List<String>>{}; // key → distinct raw names
    final logins = <String, String?>{}; // key → login (lowercase) or null
    for (final c in commits) {
      final login = c.author.login.trim();
      final name = c.author.name.trim();

      String key;
      String? loginKey;
      if (login.isNotEmpty) {
        loginKey = login.toLowerCase();
        key = loginKey;
      } else if (name.isNotEmpty && nameToLogin.containsKey(norm(name))) {
        loginKey = nameToLogin[norm(name)];
        key = loginKey!;
      } else if (name.isNotEmpty) {
        key = norm(name);
      } else {
        key = 'unknown';
      }

      counts.update(key, (v) => v + 1, ifAbsent: () => 1);
      logins.putIfAbsent(key, () => loginKey);
      // Record the canonical login casing if this is a richer sighting.
      if (loginKey != null && logins[key] == null) logins[key] = loginKey;
      final bucketNames = names.putIfAbsent(key, () => []);
      if (name.isNotEmpty && !bucketNames.contains(name)) {
        bucketNames.add(name);
      }
    }

    final total = counts.values.fold<int>(0, (a, b) => a + b);

    final list = [
      for (final entry in counts.entries)
        () {
          final loginKey = logins[entry.key];
          final display = loginKey != null ? loginDisplay[loginKey] : null;
          final bucketNames = names[entry.key] ?? const <String>[];
          final label = display ??
              (bucketNames.isNotEmpty ? bucketNames.first : 'unknown');
          return AuthorGroup(
            key: entry.key,
            label: label,
            commitCount: entry.value,
            names: List<String>.unmodifiable(bucketNames),
            login: display,
            pct: total == 0 ? 0 : ((entry.value / total) * 100).round(),
          );
        }(),
    ]..sort((a, b) {
        final byCount = b.commitCount.compareTo(a.commitCount);
        return byCount != 0 ? byCount : a.label.compareTo(b.label);
      });
    return list;
  }

  // Resolves a member uid to its display label. Prefers the async-resolved
  // GitHub name in [names]; before that lands (or when the member is absent),
  // falls back to the raw uid — the only human-facing identifier available.
  static String _labelFor(
    String id,
    Map<String, Member> byId,
    Map<String, String> names,
  ) {
    final resolved = names[id];
    if (resolved != null && resolved.isNotEmpty) return resolved;
    return id; // not yet resolved / no match → raw id
  }

  // Notify only while alive — prevents post-dispose async callbacks tripping
  // debugAssertNotDisposed.
  void _safeNotify() {
    if (_disposed) return;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
