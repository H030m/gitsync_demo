import 'package:cloud_firestore/cloud_firestore.dart';

import '../config/app_config.dart';
import '../models/app_user.dart';
import 'fake/fake_user_repo.dart';
import 'firestore_paths.dart';

/// User CRUD against `apps/gitsync/users/{userId}`.
///
/// Concrete impl picked at construction time:
///   - `AppConfig.useFakeBackend == true` → [FakeUserRepository] (in-memory)
///   - otherwise → live Firestore-backed impl
abstract class UserRepository {
  factory UserRepository() => AppConfig.useFakeBackend
      ? FakeUserRepository()
      : _LiveUserRepository();

  Stream<AppUser?> streamUser(String userId);
  Future<AppUser?> getUser(String userId);
  Future<void> upsertUserFromAuth({
    required String userId,
    required String name,
    required String email,
    required String avatarUrl,
    required String githubLogin,
    String? githubAccessToken,
  });
  Future<void> updateFcmToken(String userId, String token);
  Future<void> updateDiscordUserId(String userId, String discordUserId);

  /// Persist the user's UI language (`AppLocale.prefValue`) so the backend can
  /// localize push notifications for them (see functions `tools/i18n.ts`).
  Future<void> updateLocale(String userId, String locale);
}

class _LiveUserRepository implements UserRepository {
  final FirebaseFirestore _db = FirebaseFirestore.instance;
  static const _timeout = Duration(seconds: 10);

  @override
  Stream<AppUser?> streamUser(String userId) {
    return _db.doc(FirestorePaths.user(userId)).snapshots().map((snap) {
      final data = snap.data();
      if (data == null) return null;
      return AppUser.fromMap(data, snap.id);
    });
  }

  @override
  Future<AppUser?> getUser(String userId) async {
    final snap =
        await _db.doc(FirestorePaths.user(userId)).get().timeout(_timeout);
    final data = snap.data();
    if (data == null) return null;
    return AppUser.fromMap(data, snap.id);
  }

  @override
  Future<void> upsertUserFromAuth({
    required String userId,
    required String name,
    required String email,
    required String avatarUrl,
    required String githubLogin,
    String? githubAccessToken,
  }) async {
    final ref = _db.doc(FirestorePaths.user(userId));
    // Read-then-write in a transaction so `createdAt` is only stamped when the
    // user doc does not yet exist. A returning user keeps their original
    // `createdAt`; every other field still merge-updates on each sign-in.
    await _db.runTransaction((txn) async {
      final snap = await txn.get(ref);
      final map = <String, dynamic>{
        'name': name,
        'email': email,
        'avatarUrl': avatarUrl,
        'githubLogin': githubLogin,
        if (githubAccessToken != null) 'githubAccessToken': githubAccessToken,
        if (!snap.exists) 'createdAt': FieldValue.serverTimestamp(),
      };
      txn.set(ref, map, SetOptions(merge: true));
    }).timeout(_timeout);
  }

  @override
  Future<void> updateFcmToken(String userId, String token) async {
    await _db
        .doc(FirestorePaths.user(userId))
        .update({'fcmToken': token}).timeout(_timeout);
  }

  @override
  Future<void> updateDiscordUserId(
      String userId, String discordUserId) async {
    await _db.doc(FirestorePaths.user(userId)).update({
      'discordUserId': discordUserId,
    }).timeout(_timeout);
  }

  @override
  Future<void> updateLocale(String userId, String locale) async {
    // set+merge (not update) so it never throws if the user doc write is racing
    // sign-in's upsert — the locale field is created either way.
    await _db
        .doc(FirestorePaths.user(userId))
        .set({'locale': locale}, SetOptions(merge: true)).timeout(_timeout);
  }
}
