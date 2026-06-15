import '../../data/dummy_data.dart';
import '../../models/pull_request.dart';
import '../pull_request_repo.dart';
import '_replay_state.dart';

class FakePullRequestRepository implements PullRequestRepository {
  factory FakePullRequestRepository() => _instance;
  FakePullRequestRepository._internal();
  static final FakePullRequestRepository _instance =
      FakePullRequestRepository._internal();

  late final Map<String, ReplayState<List<PullRequest>>> _byRepo = {
    DummyData.demoRepoId:
        ReplayState<List<PullRequest>>(DummyData.pullRequests),
  };

  ReplayState<List<PullRequest>> _state(String repoId) => _byRepo.putIfAbsent(
        repoId,
        () => ReplayState<List<PullRequest>>(const []),
      );

  @override
  Stream<List<PullRequest>> streamRecent(String repoId,
      {int limit = 50}) async* {
    yield _state(repoId).value.take(limit).toList();
    await for (final list in _state(repoId).stream) {
      yield list.take(limit).toList();
    }
  }
}
