import 'package:cloud_firestore/cloud_firestore.dart';

import '../config/app_config.dart';
import '../models/discord_digest.dart';
import 'fake/fake_discord_digest_repo.dart';
import 'firestore_paths.dart';

abstract class DiscordDigestRepository {
  factory DiscordDigestRepository() => AppConfig.useFakeBackend
      ? FakeDiscordDigestRepository()
      : _LiveDiscordDigestRepository();

  /// Streams the digest doc for [date] (YYYY-MM-DD); emits null until the
  /// backend has produced one for that day.
  Stream<DiscordDigest?> streamDigest(String repoId, String date);

  /// Streams every digest whose doc id (YYYY-MM-DD) falls inside
  /// [startKey]..[endKey] inclusive. Days without a digest are simply absent
  /// from the list. Sorted newest-first.
  Stream<List<DiscordDigest>> streamDigestsInRange(
    String repoId,
    String startKey,
    String endKey,
  );
}

// NOTE: `discordDigests` is write-blocked for clients — only Cloud Functions
// (the digest flow) writes it.
class _LiveDiscordDigestRepository implements DiscordDigestRepository {
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  @override
  Stream<DiscordDigest?> streamDigest(String repoId, String date) {
    return _db
        .doc('${FirestorePaths.discordDigests(repoId)}/$date')
        .snapshots()
        .map((snap) => snap.exists
            ? DiscordDigest.fromMap(snap.data()!, snap.id)
            : null);
  }

  @override
  Stream<List<DiscordDigest>> streamDigestsInRange(
    String repoId,
    String startKey,
    String endKey,
  ) {
    // YYYY-MM-DD ids sort lexicographically, so a string range over the doc id
    // gives the inclusive day window. Sort newest-first client-side.
    return _db
        .collection(FirestorePaths.discordDigests(repoId))
        .where(FieldPath.documentId, isGreaterThanOrEqualTo: startKey)
        .where(FieldPath.documentId, isLessThanOrEqualTo: endKey)
        .snapshots()
        .map((snap) => snap.docs
            .map((d) => DiscordDigest.fromMap(d.data(), d.id))
            .toList()
          ..sort((a, b) => b.date.compareTo(a.date)));
  }
}
