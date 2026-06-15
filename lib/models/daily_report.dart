import 'package:cloud_firestore/cloud_firestore.dart';

// Mirrors Firestore `apps/gitsync/repos/{repoId}/dailyReports/{YYYY-MM-DD}`,
// written by `summarizeDayFlow` (functions/src/flows/summarizeDay.ts).

class MemberContribution {
  final int tasksDone;
  final int commits;

  /// GitHub username resolved by the backend at report-generation time.
  /// Null on legacy reports written before names were persisted — the UI
  /// falls back to the map key.
  final String? githubLogin;
  final String? displayName;

  const MemberContribution({
    this.tasksDone = 0,
    this.commits = 0,
    this.githubLogin,
    this.displayName,
  });

  factory MemberContribution.fromMap(Map<String, dynamic> map) =>
      MemberContribution(
        tasksDone: (map['tasksDone'] as num?)?.toInt() ?? 0,
        commits: (map['commits'] as num?)?.toInt() ?? 0,
        githubLogin: map['githubLogin'] as String?,
        displayName: map['displayName'] as String?,
      );

  Map<String, dynamic> toMap() => {
        'tasksDone': tasksDone,
        'commits': commits,
        if (githubLogin != null) 'githubLogin': githubLogin,
        if (displayName != null) 'displayName': displayName,
      };
}

/// One theme in the commit-message rollup: a group of related commits the AI
/// labelled, with a one-line plain summary and how many commits it covers.
class CommitTheme {
  final String theme;
  final String summary;
  final int commitCount;

  const CommitTheme({
    required this.theme,
    required this.summary,
    this.commitCount = 0,
  });

  factory CommitTheme.fromMap(Map<String, dynamic> map) => CommitTheme(
        theme: map['theme'] as String? ?? '',
        summary: map['summary'] as String? ?? '',
        commitCount: (map['commitCount'] as num?)?.toInt() ?? 0,
      );
}

class DailyReport {
  final String date; // Doc id is the date as YYYY-MM-DD.
  final String repoId;
  final String summary;

  /// Today's key achievements, most important first.
  final List<String> highlights;

  /// Blockers/risks raised in chat or stuck tasks; empty when none.
  final List<String> blockers;

  /// The day's commits grouped into themes (commit-message rollup).
  final List<CommitTheme> commitThemes;

  final int commitCount;
  final List<String> completedTaskIds;
  final Map<String, MemberContribution> memberContributions;
  final Timestamp? generatedAt;

  const DailyReport({
    required this.date,
    required this.repoId,
    required this.summary,
    this.highlights = const [],
    this.blockers = const [],
    this.commitThemes = const [],
    this.commitCount = 0,
    this.completedTaskIds = const [],
    this.memberContributions = const {},
    this.generatedAt,
  });

  /// True when the report has no narrative content yet (so the UI can show a
  /// "generate it" empty state instead of a blank card).
  bool get isEmpty =>
      summary.isEmpty &&
      highlights.isEmpty &&
      blockers.isEmpty &&
      commitThemes.isEmpty;

  factory DailyReport.fromMap(Map<String, dynamic> map, String id) {
    final raw = Map<String, dynamic>.from(
      map['memberContributions'] as Map? ?? {},
    );
    return DailyReport(
      date: id,
      repoId: map['repoId'] as String? ?? '',
      summary: map['summary'] as String? ?? '',
      highlights: List<String>.from(map['highlights'] as List? ?? []),
      blockers: List<String>.from(map['blockers'] as List? ?? []),
      commitThemes: (map['commitThemes'] as List? ?? [])
          .map((e) => CommitTheme.fromMap(Map<String, dynamic>.from(e as Map)))
          .toList(),
      commitCount: (map['commitCount'] as num?)?.toInt() ?? 0,
      completedTaskIds:
          List<String>.from(map['completedTasks'] as List? ?? []),
      memberContributions: raw.map(
        (k, v) => MapEntry(
          k,
          MemberContribution.fromMap(Map<String, dynamic>.from(v as Map)),
        ),
      ),
      generatedAt: map['generatedAt'] as Timestamp?,
    );
  }
}
