// Models for the unified "Ask GitSync" chat — the global repo-wide assistant
// reached from the FAB on every repo-shell tab. These are plain callable-payload
// shapes (no Firestore coupling); the chat flows through the `askRepo` callable.
//
// Sources reuse the existing per-tab shapes: commits are `DailyBriefSource`
// (the backend `DayCommit` shape) and Discord clusters are `DiscordChatSnippet`
// — so the sheet renders them with the same panels the Summary / Discord tabs
// already use.
import 'daily_brief.dart';
import 'discord_chat.dart';

/// One turn of the user <-> AI conversation. Sent back as history so follow-up
/// questions keep context.
class AskRepoTurn {
  /// `'user'` or `'assistant'`.
  final String role;
  final String content;

  /// Commit windows the AI surfaced for this turn (assistant turns only), each a
  /// labeled per-person / per-task / search group rendered as its own panel.
  final List<AskRepoCommitGroup> commitGroups;

  /// Discord conversation clusters the AI surfaced (assistant turns only).
  final List<DiscordChatSnippet> discordSources;

  /// When this turn was created on the client (for the bubble timestamp).
  final DateTime? createdAt;

  const AskRepoTurn({
    required this.role,
    required this.content,
    this.commitGroups = const [],
    this.discordSources = const [],
    this.createdAt,
  });

  bool get isUser => role == 'user';

  bool get hasSources => commitGroups.isNotEmpty || discordSources.isNotEmpty;

  /// Sent back to the backend as a prior turn (role + content only).
  Map<String, dynamic> toMap() => {'role': role, 'content': content};
}

/// One labeled commit "window" the AI surfaced — the result of a single
/// per-person / per-task / search tool call. [label] is the person, task, or
/// search it represents; empty means a plain recent-activity window (the UI
/// renders it under a localized default header).
class AskRepoCommitGroup {
  final String label;
  final List<DailyBriefSource> commits;

  const AskRepoCommitGroup({this.label = '', this.commits = const []});

  factory AskRepoCommitGroup.fromMap(Map<String, dynamic> map) =>
      AskRepoCommitGroup(
        label: map['label'] as String? ?? '',
        commits: (map['commits'] as List? ?? const [])
            .map((c) =>
                DailyBriefSource.fromMap(Map<String, dynamic>.from(c as Map)))
            .toList(),
      );
}

/// The `askRepo` callable's response: the AI answer plus the commit windows and
/// Discord clusters it surfaced as cited sources.
class AskRepoReply {
  final String answer;
  final List<AskRepoCommitGroup> commitGroups;
  final List<DiscordChatSnippet> snippets;

  const AskRepoReply({
    required this.answer,
    this.commitGroups = const [],
    this.snippets = const [],
  });

  factory AskRepoReply.fromMap(Map<String, dynamic> map) {
    // Prefer the grouped windows; fall back to wrapping the flat `commits` list
    // in a single unlabeled window (legacy payloads / fake backend).
    final rawGroups = map['commitGroups'] as List?;
    final groups = rawGroups != null
        ? rawGroups
            .map((g) =>
                AskRepoCommitGroup.fromMap(Map<String, dynamic>.from(g as Map)))
            .where((g) => g.commits.isNotEmpty)
            .toList()
        : <AskRepoCommitGroup>[];
    if (groups.isEmpty) {
      final flat = (map['commits'] as List? ?? const [])
          .map((c) =>
              DailyBriefSource.fromMap(Map<String, dynamic>.from(c as Map)))
          .toList();
      if (flat.isNotEmpty) {
        groups.add(AskRepoCommitGroup(commits: flat));
      }
    }
    return AskRepoReply(
      answer: map['answer'] as String? ?? '',
      commitGroups: groups,
      snippets: (map['snippets'] as List? ?? const [])
          .map((s) =>
              DiscordChatSnippet.fromMap(Map<String, dynamic>.from(s as Map)))
          .toList(),
    );
  }
}
