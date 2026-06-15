import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/app_user.dart';
import '../models/member.dart';
import '../repositories/member_repo.dart';
import '../repositories/user_repo.dart';

class MembersViewModel with ChangeNotifier {
  MembersViewModel({
    required String repoId,
    MemberRepository? memberRepository,
    UserRepository? userRepository,
  })  : _repoId = repoId,
        _repo = memberRepository ?? MemberRepository(),
        _userRepo = userRepository ?? UserRepository() {
    _sub = _repo.streamMembers(_repoId).listen((members) {
      _members = members;
      _loading = false;
      _resolveProfiles(members);
      notifyListeners();
    });
  }

  final String _repoId;
  final MemberRepository _repo;
  final UserRepository _userRepo;
  StreamSubscription<List<Member>>? _sub;

  List<Member> _members = [];
  List<Member> get members => _members;

  bool _loading = true;
  bool get loading => _loading;

  // ---- Member profile resolution (name / avatar / githubLogin) ------------
  //
  // `Member` only carries userId + role + workload counts; the human-facing
  // profile lives in `users/{uid}`. Resolve each member's [AppUser] once,
  // caching the result and notifying as each lookup lands so views (e.g. the
  // task-detail assignee picker) refresh in place. Mirrors StatsViewModel's
  // name-resolution pattern.

  final Map<String, AppUser> _profiles = {};
  final Set<String> _resolving = {};

  /// The cached [AppUser] for [userId], or null until its lookup lands (or if
  /// the user doc is missing / the lookup failed).
  AppUser? profileFor(String userId) => _profiles[userId];

  /// Display label for [userId]: githubLogin, then name, then the raw uid.
  String labelFor(String userId) {
    final u = _profiles[userId];
    if (u == null) return userId;
    if (u.githubLogin.isNotEmpty) return u.githubLogin;
    if (u.name.isNotEmpty) return u.name;
    return userId;
  }

  void _resolveProfiles(List<Member> members) {
    for (final m in members) {
      ensureResolved(m.userId);
    }
  }

  /// Fetch [userId]'s profile if it isn't already cached / in flight, then
  /// notify so labels refresh in place. Unlike [_resolveProfiles] this works for
  /// ANY uid — including an assignee whose member doc lags the task, or one a
  /// previous lookup missed — so the assignee card never gets stuck showing a
  /// raw UID. Safe to call repeatedly and from a post-frame callback.
  void ensureResolved(String userId) {
    if (userId.isEmpty) return;
    if (_profiles.containsKey(userId) || _resolving.contains(userId)) return;
    _resolving.add(userId);
    _userRepo.getUser(userId).then((user) {
      if (user != null) _profiles[userId] = user;
    }).catchError((_) {
      // Tolerate lookup failure — leave uncached so a later refresh retries.
    }).whenComplete(() {
      _resolving.remove(userId);
      notifyListeners();
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}
