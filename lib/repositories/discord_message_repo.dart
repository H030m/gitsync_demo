import 'package:cloud_firestore/cloud_firestore.dart';

import '../config/app_config.dart';
import '../models/discord_message.dart';
import 'fake/fake_discord_message_repo.dart';
import 'firestore_paths.dart';

abstract class DiscordMessageRepository {
  factory DiscordMessageRepository() => AppConfig.useFakeBackend
      ? FakeDiscordMessageRepository()
      : _LiveDiscordMessageRepository();

  Stream<List<DiscordMessage>> streamRecent(String repoId, {int limit = 100});
}

// NOTE: `discordMessages` is write-blocked for clients.
class _LiveDiscordMessageRepository implements DiscordMessageRepository {
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  @override
  Stream<List<DiscordMessage>> streamRecent(String repoId,
      {int limit = 100}) {
    return _db
        .collection(FirestorePaths.discordMessages(repoId))
        .orderBy('timestamp', descending: true)
        .limit(limit)
        .snapshots()
        .map((snap) => snap.docs
            .map((d) => DiscordMessage.fromMap(d.data(), d.id))
            .toList());
  }
}
