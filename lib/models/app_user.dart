// ignore_for_file: prefer_initializing_formals

import 'package:cloud_firestore/cloud_firestore.dart';

// Named `AppUser` to avoid clashing with `firebase_auth.User`.
// Mirrors Firestore `apps/gitsync/users/{userId}`.
class AppUser {
  final String id;
  final String name;
  final String email;
  final String avatarUrl;
  final String githubLogin;

  // NOTE: `githubAccessToken` must be an encrypted string in production
  // (route through Cloud KMS before persisting; ARCHITECTURE.md §6.1).
  // Plain text is tolerated only during local development.
  final String? githubAccessToken;

  // 18-digit Discord snowflake. Lets the RAG layer map
  // `discordMessages.authorId` back to this user.
  // See MEMORY.md 2026-05-26 "users must add discordUserId column".
  final String? discordUserId;

  final String? fcmToken;

  // UI language preference (`AppLocale.prefValue`: 'en' | 'zhHant'). Written by
  // the client so the backend can localize push notifications per recipient
  // (see functions `tools/i18n.ts`). The client itself reads its language from
  // LocaleNotifier / SharedPreferences, not from here.
  final String? locale;

  final List<String> expertiseTags;
  Timestamp? _createdAt;
  Timestamp get createdAt => _createdAt ?? Timestamp.now();

  AppUser({
    required this.id,
    required this.name,
    required this.email,
    required this.avatarUrl,
    required this.githubLogin,
    this.githubAccessToken,
    this.discordUserId,
    this.fcmToken,
    this.locale,
    this.expertiseTags = const [],
  });

  AppUser._({
    required this.id,
    required this.name,
    required this.email,
    required this.avatarUrl,
    required this.githubLogin,
    this.githubAccessToken,
    this.discordUserId,
    this.fcmToken,
    this.locale,
    required this.expertiseTags,
    required Timestamp? createdAt,
  }) : _createdAt = createdAt;

  factory AppUser.fromMap(Map<String, dynamic> map, String id) {
    return AppUser._(
      id: id,
      name: map['name'] as String? ?? '',
      email: map['email'] as String? ?? '',
      avatarUrl: map['avatarUrl'] as String? ?? '',
      githubLogin: map['githubLogin'] as String? ?? '',
      githubAccessToken: map['githubAccessToken'] as String?,
      discordUserId: map['discordUserId'] as String?,
      fcmToken: map['fcmToken'] as String?,
      locale: map['locale'] as String?,
      expertiseTags: List<String>.from(map['expertiseTags'] as List? ?? []),
      createdAt: map['createdAt'] as Timestamp?,
    );
  }

  Map<String, dynamic> toMap() => {
        'name': name,
        'email': email,
        'avatarUrl': avatarUrl,
        'githubLogin': githubLogin,
        if (githubAccessToken != null) 'githubAccessToken': githubAccessToken,
        if (discordUserId != null) 'discordUserId': discordUserId,
        if (fcmToken != null) 'fcmToken': fcmToken,
        if (locale != null) 'locale': locale,
        'expertiseTags': expertiseTags,
        'createdAt': _createdAt,
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) || (other is AppUser && other.id == id);
  @override
  int get hashCode => id.hashCode;
}
