// ignore_for_file: prefer_initializing_formals

import 'package:cloud_firestore/cloud_firestore.dart';

// Mirrors Firestore `apps/gitsync/repos/{repoId}/commits/{commitSha}`.
// NOTE: The `messageEmbedding` (Vector) field is deliberately not mapped
// to the Flutter side — it is only consumed by backend vector search.

class CommitAuthor {
  final String login;
  final String name;
  final String email;

  const CommitAuthor({
    required this.login,
    required this.name,
    required this.email,
  });

  factory CommitAuthor.fromMap(Map<String, dynamic> map) => CommitAuthor(
    login: map['login'] as String? ?? '',
    name: map['name'] as String? ?? '',
    email: map['email'] as String? ?? '',
  );

  Map<String, dynamic> toMap() => {
    'login': login,
    'name': name,
    'email': email,
  };
}

class Commit {
  final String sha;
  final String repoId;
  final String message;
  final CommitAuthor author;
  final String url;
  final List<String> filesChanged;
  final int additions;
  final int deletions;
  final List<String> linkedTaskIds;
  final String? aiSummary;

  /// The branch this commit was first pushed to (webhook `ref`). Nullable:
  /// legacy docs ingested before all-branch ingestion lack the field.
  final String? branch;

  Timestamp? _committedAt;
  Timestamp get committedAt => _committedAt ?? Timestamp.now();

  Commit({
    required this.sha,
    required this.repoId,
    required this.message,
    required this.author,
    required this.url,
    this.filesChanged = const [],
    this.additions = 0,
    this.deletions = 0,
    this.linkedTaskIds = const [],
    this.aiSummary,
    this.branch,
    Timestamp? committedAt,
  }) : _committedAt = committedAt;

  Commit._({
    required this.sha,
    required this.repoId,
    required this.message,
    required this.author,
    required this.url,
    required this.filesChanged,
    required this.additions,
    required this.deletions,
    required this.linkedTaskIds,
    this.aiSummary,
    this.branch,
    required Timestamp? committedAt,
  }) : _committedAt = committedAt;

  factory Commit.fromMap(Map<String, dynamic> map, String sha) {
    return Commit._(
      sha: sha,
      repoId: map['repoId'] as String? ?? '',
      message: map['message'] as String? ?? '',
      author: CommitAuthor.fromMap(
        Map<String, dynamic>.from(map['author'] as Map? ?? {}),
      ),
      url: map['url'] as String? ?? '',
      filesChanged: _parseFiles(map['filesChanged']),
      additions: (map['additions'] as num?)?.toInt() ?? 0,
      deletions: (map['deletions'] as num?)?.toInt() ?? 0,
      linkedTaskIds: List<String>.from(map['linkedTaskIds'] as List? ?? []),
      aiSummary: map['aiSummary'] as String?,
      branch: (map['branch'] as String?)?.isEmpty ?? true
          ? null
          : map['branch'] as String?,
      committedAt: _parseTimestamp(map['committedAt']),
    );
  }

  /// Tolerates the legacy webhook shape (ISO-8601 string) on top of the
  /// canonical Firestore [Timestamp] — a hard `as Timestamp?` cast used to
  /// throw inside the commit stream and hang the Commits tab spinner.
  static Timestamp? _parseTimestamp(Object? value) {
    if (value is Timestamp) return value;
    if (value is String) {
      final parsed = DateTime.tryParse(value);
      if (parsed != null) return Timestamp.fromDate(parsed);
    }
    return null;
  }

  /// Tolerates the legacy webhook shape (a file *count*) by degrading to an
  /// empty list; canonical shape is the list of touched file paths.
  static List<String> _parseFiles(Object? value) {
    if (value is List) return value.map((e) => '$e').toList();
    return const [];
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) || (other is Commit && other.sha == sha);
  @override
  int get hashCode => sha.hashCode;
}
