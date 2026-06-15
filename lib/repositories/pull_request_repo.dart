import 'package:cloud_firestore/cloud_firestore.dart';

import '../config/app_config.dart';
import '../models/pull_request.dart';
import 'fake/fake_pull_request_repo.dart';
import 'firestore_paths.dart';

abstract class PullRequestRepository {
  factory PullRequestRepository() => AppConfig.useFakeBackend
      ? FakePullRequestRepository()
      : _LivePullRequestRepository();

  Stream<List<PullRequest>> streamRecent(String repoId, {int limit = 50});
}

// NOTE: `pullRequests` is write-blocked for clients; Cloud Functions only.
class _LivePullRequestRepository implements PullRequestRepository {
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  @override
  Stream<List<PullRequest>> streamRecent(String repoId, {int limit = 50}) {
    return _db
        .collection(FirestorePaths.pullRequests(repoId))
        .orderBy('mergedAt', descending: true)
        .limit(limit)
        .snapshots()
        .map((snap) =>
            snap.docs.map((d) => PullRequest.fromMap(d.data(), d.id)).toList());
  }
}
