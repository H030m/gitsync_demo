import 'package:cloud_firestore/cloud_firestore.dart';

import '../config/app_config.dart';
import '../models/repo.dart';
import 'fake/fake_repo_repo.dart';
import 'firestore_paths.dart';

abstract class RepoRepository {
  factory RepoRepository() => AppConfig.useFakeBackend
      ? FakeRepoRepository()
      : _LiveRepoRepository();

  Stream<List<Repo>> streamReposOfUser(String userId);
  Stream<Repo?> streamRepo(String repoId);
  Future<Repo?> getRepo(String repoId);
  Future<void> updateMetadata(String repoId, Map<String, dynamic> patch);
}

class _LiveRepoRepository implements RepoRepository {
  final FirebaseFirestore _db = FirebaseFirestore.instance;
  static const _timeout = Duration(seconds: 10);

  @override
  Stream<List<Repo>> streamReposOfUser(String userId) {
    return _db
        .collection(FirestorePaths.repos)
        .where('memberIds', arrayContains: userId)
        .snapshots()
        .map((snap) => snap.docs
            .map((d) => Repo.fromMap(d.data(), d.id))
            .toList());
  }

  @override
  Stream<Repo?> streamRepo(String repoId) {
    return _db.doc(FirestorePaths.repo(repoId)).snapshots().map((snap) {
      final data = snap.data();
      if (data == null) return null;
      return Repo.fromMap(data, snap.id);
    });
  }

  @override
  Future<Repo?> getRepo(String repoId) async {
    final snap = await _db
        .doc(FirestorePaths.repo(repoId))
        .get()
        .timeout(_timeout);
    final data = snap.data();
    if (data == null) return null;
    return Repo.fromMap(data, snap.id);
  }

  @override
  Future<void> updateMetadata(
      String repoId, Map<String, dynamic> patch) async {
    await _db.doc(FirestorePaths.repo(repoId)).update(patch).timeout(_timeout);
  }
}
