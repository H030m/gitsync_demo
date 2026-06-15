// ignore_for_file: prefer_initializing_formals

import 'package:cloud_firestore/cloud_firestore.dart';

// Mirrors Firestore `apps/gitsync/repos/{repoId}/tasks/{taskId}`.

enum TaskStatus { todo, inProgress, done }

extension TaskStatusX on TaskStatus {
  String get wire => switch (this) {
        TaskStatus.todo => 'todo',
        TaskStatus.inProgress => 'in_progress',
        TaskStatus.done => 'done',
      };

  static TaskStatus fromWire(String? s) => switch (s) {
        'in_progress' => TaskStatus.inProgress,
        'done' => TaskStatus.done,
        _ => TaskStatus.todo,
      };
}

enum TaskSource { manual, aiBreakdown, githubIssue }

extension TaskSourceX on TaskSource {
  String get wire => switch (this) {
        TaskSource.manual => 'manual',
        TaskSource.aiBreakdown => 'ai_breakdown',
        TaskSource.githubIssue => 'github_issue',
      };

  static TaskSource fromWire(String? s) => switch (s) {
        'ai_breakdown' => TaskSource.aiBreakdown,
        'github_issue' => TaskSource.githubIssue,
        _ => TaskSource.manual,
      };
}

class Task {
  final String id;
  final String title;
  final String description;
  final TaskStatus status;
  final String? assigneeId;

  // Real task IDs. On the LLM side these are `number[]` (indices); the
  // backend translates them to `string[]` taskIds before writing to
  // Firestore. See MEMORY.md 2026-05-26 "dependsOn type contract".
  final List<String> dependsOn;

  final int? githubIssueNumber;
  final List<int> linkedPRNumbers;
  final List<String> acceptanceCriteria;
  final String? handoffDoc;
  final Timestamp? handoffGeneratedAt;
  final TaskSource source;
  final String? parentTaskId;
  final String createdBy;
  Timestamp? _createdAt;
  Timestamp get createdAt => _createdAt ?? Timestamp.now();
  Timestamp? _updatedAt;
  Timestamp get updatedAt => _updatedAt ?? createdAt;

  Task({
    required this.id,
    required this.title,
    this.description = '',
    this.status = TaskStatus.todo,
    this.assigneeId,
    this.dependsOn = const [],
    this.githubIssueNumber,
    this.linkedPRNumbers = const [],
    this.acceptanceCriteria = const [],
    this.handoffDoc,
    this.handoffGeneratedAt,
    this.source = TaskSource.manual,
    this.parentTaskId,
    required this.createdBy,
  });

  Task._({
    required this.id,
    required this.title,
    required this.description,
    required this.status,
    this.assigneeId,
    required this.dependsOn,
    this.githubIssueNumber,
    required this.linkedPRNumbers,
    required this.acceptanceCriteria,
    this.handoffDoc,
    this.handoffGeneratedAt,
    required this.source,
    this.parentTaskId,
    required this.createdBy,
    required Timestamp? createdAt,
    required Timestamp? updatedAt,
  })  : _createdAt = createdAt,
        _updatedAt = updatedAt;

  factory Task.fromMap(Map<String, dynamic> map, String id) {
    return Task._(
      id: id,
      title: map['title'] as String? ?? '',
      description: map['description'] as String? ?? '',
      status: TaskStatusX.fromWire(map['status'] as String?),
      assigneeId: map['assigneeId'] as String?,
      dependsOn: List<String>.from(map['dependsOn'] as List? ?? []),
      githubIssueNumber: (map['githubIssueNumber'] as num?)?.toInt(),
      linkedPRNumbers: List<int>.from(
        (map['linkedPRNumbers'] as List? ?? [])
            .map((e) => (e as num).toInt()),
      ),
      acceptanceCriteria:
          List<String>.from(map['acceptanceCriteria'] as List? ?? []),
      handoffDoc: map['handoffDoc'] as String?,
      handoffGeneratedAt: map['handoffGeneratedAt'] as Timestamp?,
      source: TaskSourceX.fromWire(map['source'] as String?),
      parentTaskId: map['parentTaskId'] as String?,
      createdBy: map['createdBy'] as String? ?? '',
      createdAt: map['createdAt'] as Timestamp?,
      updatedAt: map['updatedAt'] as Timestamp?,
    );
  }

  Map<String, dynamic> toMap() => {
        'title': title,
        'description': description,
        'status': status.wire,
        if (assigneeId != null) 'assigneeId': assigneeId,
        'dependsOn': dependsOn,
        if (githubIssueNumber != null) 'githubIssueNumber': githubIssueNumber,
        'linkedPRNumbers': linkedPRNumbers,
        'acceptanceCriteria': acceptanceCriteria,
        if (handoffDoc != null) 'handoffDoc': handoffDoc,
        if (handoffGeneratedAt != null)
          'handoffGeneratedAt': handoffGeneratedAt,
        'source': source.wire,
        if (parentTaskId != null) 'parentTaskId': parentTaskId,
        'createdBy': createdBy,
        'createdAt': _createdAt,
        'updatedAt': _updatedAt,
      };

  @override
  bool operator ==(Object other) =>
      identical(this, other) || (other is Task && other.id == id);
  @override
  int get hashCode => id.hashCode;
}
