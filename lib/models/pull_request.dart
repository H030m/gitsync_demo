import 'package:cloud_firestore/cloud_firestore.dart';

// Mirrors Firestore `apps/gitsync/repos/{repoId}/pullRequests/{prNumber}`.

enum PrState { open, merged, closed }

extension PrStateX on PrState {
  String get wire => switch (this) {
        PrState.open => 'open',
        PrState.merged => 'merged',
        PrState.closed => 'closed',
      };

  static PrState fromWire(String? s) => switch (s) {
        'merged' => PrState.merged,
        'closed' => PrState.closed,
        _ => PrState.open,
      };
}

class DiffStat {
  final int additions;
  final int deletions;
  final int changedFiles;

  const DiffStat({
    this.additions = 0,
    this.deletions = 0,
    this.changedFiles = 0,
  });

  factory DiffStat.fromMap(Map<String, dynamic> map) => DiffStat(
        additions: (map['additions'] as num?)?.toInt() ?? 0,
        deletions: (map['deletions'] as num?)?.toInt() ?? 0,
        changedFiles: (map['changedFiles'] as num?)?.toInt() ?? 0,
      );

  Map<String, dynamic> toMap() => {
        'additions': additions,
        'deletions': deletions,
        'changedFiles': changedFiles,
      };
}

class PullRequest {
  final int number; // PR number is the doc id.
  final String repoId;
  final String title;
  final PrState state;
  final String author;
  final String headBranch;
  final String baseBranch;
  final List<String> linkedTaskIds;
  final List<String> commitShas;
  final DiffStat diffStat;
  final String url;
  final Timestamp? mergedAt;

  PullRequest({
    required this.number,
    required this.repoId,
    required this.title,
    required this.state,
    required this.author,
    required this.headBranch,
    required this.baseBranch,
    required this.url,
    this.linkedTaskIds = const [],
    this.commitShas = const [],
    this.diffStat = const DiffStat(),
    this.mergedAt,
  });

  factory PullRequest.fromMap(Map<String, dynamic> map, String id) {
    return PullRequest(
      number: int.tryParse(id) ?? (map['number'] as num?)?.toInt() ?? 0,
      repoId: map['repoId'] as String? ?? '',
      title: map['title'] as String? ?? '',
      state: PrStateX.fromWire(map['state'] as String?),
      author: map['author'] as String? ?? '',
      headBranch: map['headBranch'] as String? ?? '',
      baseBranch: map['baseBranch'] as String? ?? '',
      linkedTaskIds: List<String>.from(map['linkedTaskIds'] as List? ?? []),
      commitShas: List<String>.from(map['commitShas'] as List? ?? []),
      diffStat: DiffStat.fromMap(
        Map<String, dynamic>.from(map['diffStat'] as Map? ?? {}),
      ),
      url: map['url'] as String? ?? '',
      mergedAt: map['mergedAt'] as Timestamp?,
    );
  }
}
