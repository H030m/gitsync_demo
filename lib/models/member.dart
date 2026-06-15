import 'package:cloud_firestore/cloud_firestore.dart';

// Mirrors Firestore `apps/gitsync/repos/{repoId}/members/{userId}`.

enum MemberRole { owner, admin, member }

extension MemberRoleX on MemberRole {
  String get wire => switch (this) {
        MemberRole.owner => 'owner',
        MemberRole.admin => 'admin',
        MemberRole.member => 'member',
      };

  static MemberRole fromWire(String? s) => switch (s) {
        'owner' => MemberRole.owner,
        'admin' => MemberRole.admin,
        _ => MemberRole.member,
      };
}

class Member {
  final String userId; // Doc id is the userId.
  final MemberRole role;

  // Live workload (consumed by the task-assignment AI). The backend
  // maintains this via atomic `FieldValue.increment`.
  final int activeIssueCount;
  final int completedTaskCount;
  final Timestamp? lastActiveAt;

  const Member({
    required this.userId,
    required this.role,
    this.activeIssueCount = 0,
    this.completedTaskCount = 0,
    this.lastActiveAt,
  });

  factory Member.fromMap(Map<String, dynamic> map, String id) {
    return Member(
      userId: id,
      role: MemberRoleX.fromWire(map['role'] as String?),
      activeIssueCount: (map['activeIssueCount'] as num?)?.toInt() ?? 0,
      completedTaskCount:
          (map['completedTaskCount'] as num?)?.toInt() ?? 0,
      lastActiveAt: map['lastActiveAt'] as Timestamp?,
    );
  }
}
