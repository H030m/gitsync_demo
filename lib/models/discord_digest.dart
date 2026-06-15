import 'package:cloud_firestore/cloud_firestore.dart';

// Mirrors Firestore `apps/gitsync/repos/{repoId}/discordDigests/{date}`,
// the AI-generated markdown summary of one day's Discord chat. Written by
// `discordDailyDigestFlow` (see functions/src/flows/discordDailyDigest.ts)
// after the bot backfills the day's messages.

class DiscordDigest {
  final String date; // YYYY-MM-DD (also the doc id)
  final String markdown;
  final int messageCount;

  /// When true the digest is pinned: no backend path (auto-regen or AI edit)
  /// will change it. Toggled via `setDigestLock`.
  final bool locked;

  /// The messages this digest was built from, with timestamps, so the card can
  /// show "referenced what, and when" rather than only the outline. Empty for
  /// legacy digests written before this field existed.
  final List<DiscordDigestSource> sourceMessages;

  Timestamp? _generatedAt;
  Timestamp get generatedAt => _generatedAt ?? Timestamp.now();

  DiscordDigest({
    required this.date,
    required this.markdown,
    required this.messageCount,
    this.locked = false,
    this.sourceMessages = const [],
    Timestamp? generatedAt,
  }) : _generatedAt = generatedAt;

  factory DiscordDigest.fromMap(Map<String, dynamic> map, String id) {
    return DiscordDigest(
      date: map['date'] as String? ?? id,
      markdown: map['markdown'] as String? ?? '',
      messageCount: map['messageCount'] as int? ?? 0,
      locked: map['locked'] as bool? ?? false,
      sourceMessages: (map['sourceMessages'] as List? ?? const [])
          .map((m) =>
              DiscordDigestSource.fromMap(Map<String, dynamic>.from(m as Map)))
          .toList(),
      generatedAt: map['generatedAt'] as Timestamp?,
    );
  }
}

/// One message a digest was built from (id-less; for display only).
class DiscordDigestSource {
  final String authorName;
  final String content;

  /// When the message was sent, parsed from the backend ISO string. Null when
  /// the source had no timestamp.
  final DateTime? timestamp;

  const DiscordDigestSource({
    required this.authorName,
    required this.content,
    this.timestamp,
  });

  factory DiscordDigestSource.fromMap(Map<String, dynamic> map) =>
      DiscordDigestSource(
        authorName: map['authorName'] as String? ?? '',
        content: map['content'] as String? ?? '',
        timestamp: DateTime.tryParse(map['timestamp'] as String? ?? '')?.toLocal(),
      );
}
