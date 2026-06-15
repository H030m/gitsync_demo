// ignore_for_file: prefer_initializing_formals

import 'package:cloud_firestore/cloud_firestore.dart';

// Mirrors Firestore `apps/gitsync/repos/{repoId}/discordMessages/{messageId}`.

class DiscordMessage {
  final String id;
  final String repoId;
  final String channelId;
  final String authorId;
  final String authorName;
  final String content;
  final List<String> mentionedUserIds;
  final List<String> linkedTaskIds;
  Timestamp? _timestamp;
  Timestamp get timestamp => _timestamp ?? Timestamp.now();

  DiscordMessage({
    required this.id,
    required this.repoId,
    required this.channelId,
    required this.authorId,
    required this.authorName,
    required this.content,
    this.mentionedUserIds = const [],
    this.linkedTaskIds = const [],
  });

  DiscordMessage._({
    required this.id,
    required this.repoId,
    required this.channelId,
    required this.authorId,
    required this.authorName,
    required this.content,
    required this.mentionedUserIds,
    required this.linkedTaskIds,
    required Timestamp? timestamp,
  }) : _timestamp = timestamp;

  factory DiscordMessage.fromMap(Map<String, dynamic> map, String id) {
    return DiscordMessage._(
      id: id,
      repoId: map['repoId'] as String? ?? '',
      channelId: map['channelId'] as String? ?? '',
      authorId: map['authorId'] as String? ?? '',
      authorName: map['authorName'] as String? ?? '',
      content: map['content'] as String? ?? '',
      mentionedUserIds:
          List<String>.from(map['mentionedUserIds'] as List? ?? []),
      linkedTaskIds: List<String>.from(map['linkedTaskIds'] as List? ?? []),
      timestamp: map['timestamp'] as Timestamp?,
    );
  }
}
