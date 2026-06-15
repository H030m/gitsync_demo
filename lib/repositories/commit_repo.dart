import 'package:cloud_firestore/cloud_firestore.dart';

import '../config/app_config.dart';
import '../models/commit.dart';
import 'fake/fake_commit_repo.dart';
import 'firestore_paths.dart';

abstract class CommitRepository {
  factory CommitRepository() => AppConfig.useFakeBackend
      ? FakeCommitRepository()
      : _LiveCommitRepository();

  Stream<List<Commit>> streamRecent(String repoId, {int limit = 50});
  Stream<List<Commit>> streamCommitsForDay(String repoId, DateTime day);

  /// Commits whose `committedAt` falls inside the inclusive local-day range
  /// [startDay]..[endDay], newest first.
  Stream<List<Commit>> streamRange(
      String repoId, DateTime startDay, DateTime endDay);

  Future<Commit?> getCommit(String repoId, String sha);

  /// One-shot fetch of EVERY commit doc in the repo (no limit, no ordering).
  /// Used by Stats for all-history contribution math. Tolerates failures at the
  /// call site (caller degrades to an empty list).
  Future<List<Commit>> fetchAllCommits(String repoId);
}

// NOTE: The `commits` collection is write-blocked for clients (Firestore
// Rules set `allow write: if false`); only Cloud Functions may write to it.
class _LiveCommitRepository implements CommitRepository {
  final FirebaseFirestore _db = FirebaseFirestore.instance;
  static const _timeout = Duration(seconds: 10);

  @override
  Stream<List<Commit>> streamRecent(String repoId, {int limit = 50}) {
    return _db
        .collection(FirestorePaths.commits(repoId))
        .orderBy('committedAt', descending: true)
        .limit(limit)
        .snapshots()
        .map((snap) =>
            snap.docs.map((d) => Commit.fromMap(d.data(), d.id)).toList());
  }

  @override
  Stream<List<Commit>> streamCommitsForDay(String repoId, DateTime day) {
    final start = DateTime(day.year, day.month, day.day);
    final end = start.add(const Duration(days: 1));
    return _db
        .collection(FirestorePaths.commits(repoId))
        .where('committedAt',
            isGreaterThanOrEqualTo: Timestamp.fromDate(start),
            isLessThan: Timestamp.fromDate(end))
        .orderBy('committedAt', descending: true)
        .snapshots()
        .map((snap) =>
            snap.docs.map((d) => Commit.fromMap(d.data(), d.id)).toList());
  }

  @override
  Stream<List<Commit>> streamRange(
      String repoId, DateTime startDay, DateTime endDay) {
    final start = DateTime(startDay.year, startDay.month, startDay.day);
    final end = DateTime(endDay.year, endDay.month, endDay.day)
        .add(const Duration(days: 1));
    return _db
        .collection(FirestorePaths.commits(repoId))
        .where('committedAt',
            isGreaterThanOrEqualTo: Timestamp.fromDate(start),
            isLessThan: Timestamp.fromDate(end))
        .orderBy('committedAt', descending: true)
        .snapshots()
        .map((snap) =>
            snap.docs.map((d) => Commit.fromMap(d.data(), d.id)).toList());
  }

  @override
  Future<Commit?> getCommit(String repoId, String sha) async {
    final snap = await _db
        .doc('${FirestorePaths.commits(repoId)}/$sha')
        .get()
        .timeout(_timeout);
    final data = snap.data();
    if (data == null) return null;
    return Commit.fromMap(data, snap.id);
  }

  @override
  Future<List<Commit>> fetchAllCommits(String repoId) async {
    final snap = await _db
        .collection(FirestorePaths.commits(repoId))
        .get()
        .timeout(_timeout);
    return snap.docs.map((d) => Commit.fromMap(d.data(), d.id)).toList();
  }
}
