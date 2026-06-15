import 'package:cloud_firestore/cloud_firestore.dart';

import '../config/app_config.dart';
import 'fake/fake_discord_fetch_repo.dart';
import 'firestore_paths.dart';

/// Streams the lifecycle status of an on-demand Discord fetch request so the UI
/// can show "Updated" only once the bot has finished the round-trip. The doc
/// lives at `apps/gitsync/repos/{repoId}/fetchRequests/{requestId}` and its
/// `status` field progresses `pending → claimed → ingested → done` (or
/// `digest_failed`).
abstract class DiscordFetchRepository {
  factory DiscordFetchRepository() => AppConfig.useFakeBackend
      ? FakeDiscordFetchRepository()
      : _LiveDiscordFetchRepository();

  /// Emits the `status` field of the fetch-request doc as it changes. Emits
  /// null while the doc is missing or has no status.
  Stream<String?> streamStatus(String repoId, String requestId);
}

class _LiveDiscordFetchRepository implements DiscordFetchRepository {
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  @override
  Stream<String?> streamStatus(String repoId, String requestId) {
    return _db
        .collection(FirestorePaths.fetchRequests(repoId))
        .doc(requestId)
        .snapshots()
        .map((snap) => snap.data()?['status'] as String?);
  }
}
