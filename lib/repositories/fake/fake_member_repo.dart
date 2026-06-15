import '../../data/dummy_data.dart';
import '../../models/member.dart';
import '../member_repo.dart';

class FakeMemberRepository implements MemberRepository {
  factory FakeMemberRepository() => _instance;
  FakeMemberRepository._internal();
  static final FakeMemberRepository _instance =
      FakeMemberRepository._internal();

  @override
  Stream<List<Member>> streamMembers(String repoId) async* {
    if (repoId != DummyData.demoRepoId) {
      yield const [];
      return;
    }
    yield DummyData.members;
  }
}
