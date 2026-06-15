import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/repo.dart';
import '../repositories/repo_repo.dart';
import '../services/functions_service.dart';

// Streams the repos the current user is a member of (RepoListPage).
class RepoListViewModel with ChangeNotifier {
  RepoListViewModel({
    required String userId,
    RepoRepository? repoRepository,
    FunctionsService? functionsService,
  })  : _userId = userId,
        _repo = repoRepository ?? RepoRepository(),
        _functions = functionsService ?? FunctionsService() {
    _sub = _repo.streamReposOfUser(_userId).listen((repos) {
      _repos = repos;
      _loading = false;
      notifyListeners();
    });
  }

  final String _userId;
  final RepoRepository _repo;
  final FunctionsService _functions;
  StreamSubscription<List<Repo>>? _sub;

  List<Repo> _repos = [];
  List<Repo> get repos => _repos;

  bool _loading = true;
  bool get loading => _loading;

  // Ids currently being removed (so the row can show a spinner / disable).
  final Set<String> _removing = {};
  bool isRemoving(String repoId) => _removing.contains(repoId);

  String? _lastError;
  String? get lastError => _lastError;

  /// Calls the `removeRepo` Cloud Function. Returns true on success.
  /// The list itself auto-updates via the `streamReposOfUser` subscription —
  /// no manual refetch needed.
  Future<bool> removeRepo(String repoId) async {
    if (_removing.contains(repoId)) return false;
    _removing.add(repoId);
    _lastError = null;
    notifyListeners();
    try {
      await _functions.removeRepo(repoId: repoId);
      return true;
    } catch (e) {
      _lastError = e.toString();
      return false;
    } finally {
      _removing.remove(repoId);
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}
