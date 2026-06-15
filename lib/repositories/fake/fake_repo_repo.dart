import '../../config/app_config.dart';
import '../../data/dummy_data.dart';
import '../../models/repo.dart';
import '../repo_repo.dart';
import '_replay_state.dart';

class FakeRepoRepository implements RepoRepository {
  factory FakeRepoRepository() => _instance;
  FakeRepoRepository._internal();
  static final FakeRepoRepository _instance = FakeRepoRepository._internal();

  // Single repo seed; mutations replace the doc.
  late final ReplayState<Repo?> _repo =
      ReplayState<Repo?>(DummyData.demoRepo);

  // Per-user repo-list streams. The demo user belongs to the demo repo.
  late final Map<String, ReplayState<List<Repo>>> _byUser = {
    DummyData.demoUserId: ReplayState<List<Repo>>([DummyData.demoRepo]),
    DummyData.aliceId: ReplayState<List<Repo>>([DummyData.demoRepo]),
    DummyData.bobId: ReplayState<List<Repo>>([DummyData.demoRepo]),
  };

  @override
  Stream<List<Repo>> streamReposOfUser(String userId) {
    final state = _byUser.putIfAbsent(
      userId,
      () => ReplayState<List<Repo>>(const []),
    );
    return state.stream;
  }

  @override
  Stream<Repo?> streamRepo(String repoId) {
    if (repoId == DummyData.demoRepoId) return _repo.stream;
    return Stream<Repo?>.value(null);
  }

  @override
  Future<Repo?> getRepo(String repoId) async {
    await Future.delayed(AppConfig.simulatedLatency);
    return repoId == DummyData.demoRepoId ? _repo.value : null;
  }

  @override
  Future<void> updateMetadata(
      String repoId, Map<String, dynamic> patch) async {
    await Future.delayed(AppConfig.simulatedLatency);
    if (repoId != DummyData.demoRepoId) return;
    final current = _repo.value;
    if (current == null) return;
    final merged = {...current.toMap(), ...patch};
    _repo.update(Repo.fromMap(merged, repoId));
  }
}
