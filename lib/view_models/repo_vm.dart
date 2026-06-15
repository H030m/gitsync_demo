import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/repo.dart';
import '../repositories/repo_repo.dart';

// Streams the current repo doc for the repo-scoped routes (e.g. TaskDetailsPage
// needs `repo.url` to build GitHub issue/PR links). Scoped in the shell so child
// routes share one subscription. Views read `repo` instead of importing a
// repository directly.
class RepoViewModel with ChangeNotifier {
  RepoViewModel({
    required String repoId,
    RepoRepository? repoRepository,
  })  : _repoId = repoId,
        _repo = repoRepository ?? RepoRepository() {
    _sub = _repo.streamRepo(_repoId).listen((repo) {
      _current = repo;
      _loading = false;
      notifyListeners();
    });
  }

  final String _repoId;
  final RepoRepository _repo;
  StreamSubscription<Repo?>? _sub;

  Repo? _current;
  Repo? get repo => _current;

  bool _loading = true;
  bool get loading => _loading;

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}
