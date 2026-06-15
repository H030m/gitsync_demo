// The `_createdAt` private field + public getter falling back to
// `Timestamp.now()` is the pattern from COURSE_METHODS.md §4.1; ignore
// `prefer_initializing_formals` here.
// ignore_for_file: prefer_initializing_formals

import 'package:cloud_firestore/cloud_firestore.dart';

// Mirrors Firestore `apps/gitsync/repos/{repoId}`.
// `repoId` format: `${owner}_${name}` or the GitHub repo numeric ID.
class Repo {
  final String id;
  final String name;
  final String url;
  final int githubRepoId;
  final String defaultBranch;

  // Outbound channel webhook URL for Discord notifications (set in-app).
  final String? discordWebhookUrl;

  // Channel IDs the forwarder bot should route to this repo.
  final List<String> discordChannelIds;

  // Discord backfill date range (YYYY-MM-DD), null when unset.
  final String? discordStartDate;
  final String? discordEndDate;

  // Mirrored from the members subcollection so we can `array-contains` query.
  final List<String> memberIds;

  // Distributed lock: an AI breakdown is currently running.
  // See MEMORY.md 2026-05-26 "breakdownTaskFlow must add a distributed lock".
  final bool isBreakingDown;
  final Timestamp? breakdownStartedAt;

  final String createdBy;
  Timestamp? _createdAt;
  Timestamp get createdAt => _createdAt ?? Timestamp.now();

  Repo({
    required this.id,
    required this.name,
    required this.url,
    required this.githubRepoId,
    required this.defaultBranch,
    required this.createdBy,
    this.discordWebhookUrl,
    this.discordChannelIds = const [],
    this.discordStartDate,
    this.discordEndDate,
    this.memberIds = const [],
    this.isBreakingDown = false,
    this.breakdownStartedAt,
  });

  Repo._({
    required this.id,
    required this.name,
    required this.url,
    required this.githubRepoId,
    required this.defaultBranch,
    required this.createdBy,
    this.discordWebhookUrl,
    required this.discordChannelIds,
    this.discordStartDate,
    this.discordEndDate,
    required this.memberIds,
    required this.isBreakingDown,
    this.breakdownStartedAt,
    required Timestamp? createdAt,
  }) : _createdAt = createdAt;

  factory Repo.fromMap(Map<String, dynamic> map, String id) {
    return Repo._(
      id: id,
      name: map['name'] as String? ?? '',
      url: map['url'] as String? ?? '',
      githubRepoId: (map['githubRepoId'] as num?)?.toInt() ?? 0,
      defaultBranch: map['defaultBranch'] as String? ?? 'main',
      createdBy: map['createdBy'] as String? ?? '',
      discordWebhookUrl: map['discordWebhookUrl'] as String?,
      discordChannelIds:
          List<String>.from(map['discordChannelIds'] as List? ?? []),
      discordStartDate: map['discordStartDate'] as String?,
      discordEndDate: map['discordEndDate'] as String?,
      memberIds: List<String>.from(map['memberIds'] as List? ?? []),
      isBreakingDown: map['isBreakingDown'] as bool? ?? false,
      breakdownStartedAt: map['breakdownStartedAt'] as Timestamp?,
      createdAt: map['createdAt'] as Timestamp?,
    );
  }

  Map<String, dynamic> toMap() => {
        'name': name,
        'url': url,
        'githubRepoId': githubRepoId,
        'defaultBranch': defaultBranch,
        'createdBy': createdBy,
        if (discordWebhookUrl != null) 'discordWebhookUrl': discordWebhookUrl,
        'discordChannelIds': discordChannelIds,
        if (discordStartDate != null) 'discordStartDate': discordStartDate,
        if (discordEndDate != null) 'discordEndDate': discordEndDate,
        'memberIds': memberIds,
        'isBreakingDown': isBreakingDown,
        if (breakdownStartedAt != null)
          'breakdownStartedAt': breakdownStartedAt,
        'createdAt': _createdAt,
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) || (other is Repo && other.id == id);
  @override
  int get hashCode => id.hashCode;
}
