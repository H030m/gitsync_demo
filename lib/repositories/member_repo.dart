import 'package:cloud_firestore/cloud_firestore.dart';

import '../config/app_config.dart';
import '../models/member.dart';
import 'fake/fake_member_repo.dart';
import 'firestore_paths.dart';

abstract class MemberRepository {
  factory MemberRepository() => AppConfig.useFakeBackend
      ? FakeMemberRepository()
      : _LiveMemberRepository();

  Stream<List<Member>> streamMembers(String repoId);
}

// NOTE: `members` is write-blocked for clients.
class _LiveMemberRepository implements MemberRepository {
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  @override
  Stream<List<Member>> streamMembers(String repoId) {
    return _db
        .collection(FirestorePaths.members(repoId))
        .snapshots()
        .map((snap) =>
            snap.docs.map((d) => Member.fromMap(d.data(), d.id)).toList());
  }
}
