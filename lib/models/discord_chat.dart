// Models for the Discord AI chat feature. These are plain
// callable-payload shapes (no Firestore Timestamp coupling), since the chat
// flows entirely through the `discordChat` Cloud Functions callable.

/// One turn of the user <-> AI conversation, sent back to the backend as
/// history so follow-up questions keep context.
class DiscordChatTurn {
  /// `'user'` or `'assistant'`.
  final String role;
  final String content;

  /// Conversation clusters the AI surfaced for this turn (assistant turns
  /// only). Shown in the scrollable sources panel; not sent back to the
  /// backend.
  final List<DiscordChatSnippet> snippets;

  /// When this turn was created on the client (for the bubble timestamp).
  /// Null only for transient placeholders.
  final DateTime? createdAt;

  const DiscordChatTurn({
    required this.role,
    required this.content,
    this.snippets = const [],
    this.createdAt,
  });

  bool get isUser => role == 'user';

  Map<String, dynamic> toMap() => {'role': role, 'content': content};
}

/// A Discord message the AI cited, as returned by the callable.
class DiscordChatSource {
  final String messageId;
  final String channelId;
  final String authorName;
  final String content;

  /// ISO 8601 string, or null if the source had no timestamp.
  final String? timestamp;

  /// Whether this message actually matched the query. False for surrounding
  /// context messages included to make the cluster readable.
  final bool isMatch;

  const DiscordChatSource({
    required this.messageId,
    required this.channelId,
    required this.authorName,
    required this.content,
    this.timestamp,
    this.isMatch = false,
  });

  factory DiscordChatSource.fromMap(Map<String, dynamic> map) {
    return DiscordChatSource(
      messageId: map['messageId'] as String? ?? '',
      channelId: map['channelId'] as String? ?? '',
      authorName: map['authorName'] as String? ?? '',
      content: map['content'] as String? ?? '',
      timestamp: map['timestamp'] as String?,
      isMatch: map['isMatch'] as bool? ?? false,
    );
  }
}

/// A conversation cluster the AI surfaced: a run of chronological messages
/// (oldest → newest) from one channel, where the matched message(s) are
/// flanked by surrounding context.
class DiscordChatSnippet {
  final String channelId;
  final List<DiscordChatSource> messages;

  const DiscordChatSnippet({
    required this.channelId,
    required this.messages,
  });

  factory DiscordChatSnippet.fromMap(Map<String, dynamic> map) {
    final raw = map['messages'] as List? ?? const [];
    return DiscordChatSnippet(
      channelId: map['channelId'] as String? ?? '',
      messages: raw
          .map((m) =>
              DiscordChatSource.fromMap(Map<String, dynamic>.from(m as Map)))
          .toList(),
    );
  }
}

/// The callable's response: the AI answer plus the conversation clusters it
/// surfaced.
class DiscordChatReply {
  final String answer;
  final List<DiscordChatSnippet> snippets;

  const DiscordChatReply({required this.answer, required this.snippets});

  factory DiscordChatReply.fromMap(Map<String, dynamic> map) {
    final raw = map['snippets'] as List? ?? const [];
    return DiscordChatReply(
      answer: map['answer'] as String? ?? '',
      snippets: raw
          .map((s) =>
              DiscordChatSnippet.fromMap(Map<String, dynamic>.from(s as Map)))
          .toList(),
    );
  }
}
