// Models for the "ask AI about today" chat in the Summary tab — the developer
// intelligence hub. These are plain callable-payload shapes (no Firestore
// coupling); the chat flows entirely through the `dailyBrief` callable.

/// One turn of the user <-> AI conversation. Sent back as history so follow-up
/// questions keep context.
class DailyBriefTurn {
  /// `'user'` or `'assistant'`.
  final String role;
  final String content;

  /// Commits the AI surfaced for this turn (assistant turns only). Shown under
  /// the answer; not sent back to the backend.
  final List<DailyBriefSource> sources;

  /// When this turn was created on the client (for the bubble timestamp).
  final DateTime? createdAt;

  const DailyBriefTurn({
    required this.role,
    required this.content,
    this.sources = const [],
    this.createdAt,
  });

  bool get isUser => role == 'user';

  Map<String, dynamic> toMap() => {'role': role, 'content': content};
}

/// A commit the AI cited, as returned by the `dailyBrief` callable (the
/// backend's `DayCommit` shape).
class DailyBriefSource {
  final String sha;
  final String message;
  final String authorName;
  final String authorLogin;
  final String? aiSummary;
  final List<String> linkedTaskIds;

  /// When the commit was committed (UTC, parsed from the backend ISO string).
  /// Null for legacy payloads that predate the field.
  final DateTime? committedAt;

  const DailyBriefSource({
    required this.sha,
    required this.message,
    required this.authorName,
    required this.authorLogin,
    this.aiSummary,
    this.linkedTaskIds = const [],
    this.committedAt,
  });

  String get shortSha => sha.length >= 7 ? sha.substring(0, 7) : sha;

  factory DailyBriefSource.fromMap(Map<String, dynamic> map) => DailyBriefSource(
        sha: map['sha'] as String? ?? '',
        message: map['message'] as String? ?? '',
        authorName: map['authorName'] as String? ?? '',
        authorLogin: map['authorLogin'] as String? ?? '',
        aiSummary: map['aiSummary'] as String?,
        linkedTaskIds: List<String>.from(map['linkedTaskIds'] as List? ?? []),
        committedAt: DateTime.tryParse(map['committedAt'] as String? ?? '')
            ?.toLocal(),
      );
}

/// The callable's response: the AI answer plus the commits it surfaced.
class DailyBriefReply {
  final String answer;
  final List<DailyBriefSource> sources;

  const DailyBriefReply({required this.answer, this.sources = const []});

  factory DailyBriefReply.fromMap(Map<String, dynamic> map) => DailyBriefReply(
        answer: map['answer'] as String? ?? '',
        sources: (map['commits'] as List? ?? [])
            .map((c) =>
                DailyBriefSource.fromMap(Map<String, dynamic>.from(c as Map)))
            .toList(),
      );
}
