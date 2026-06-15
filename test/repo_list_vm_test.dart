import 'package:flutter_test/flutter_test.dart';
import 'package:gitsync/models/ask_repo.dart';
import 'package:gitsync/models/commit_graph.dart';
import 'package:gitsync/models/daily_brief.dart';
import 'package:gitsync/models/discord_chat.dart';
import 'package:gitsync/models/repo.dart';
import 'package:gitsync/models/sub_task.dart';
import 'package:gitsync/repositories/repo_repo.dart';
import 'package:gitsync/services/functions_service.dart';
import 'package:gitsync/view_models/repo_list_vm.dart';

/// Hand-rolled fake (no mockito/mocktail). The VM only ever calls
/// `streamReposOfUser` on construction; the rest throw if touched.
class _FakeRepoRepository implements RepoRepository {
  @override
  Stream<List<Repo>> streamReposOfUser(String userId) =>
      Stream<List<Repo>>.value(const []);

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError(invocation.memberName.toString());
}

/// Hand-rolled fake of the callable surface. Only `removeRepo` is exercised;
/// every other callable throws if the VM ever reaches for it.
class _FakeFunctionsService implements FunctionsService {
  _FakeFunctionsService({this.errorToThrow});

  /// If set, `removeRepo` throws this instead of completing.
  final Object? errorToThrow;

  int removeCalls = 0;
  String? lastRepoId;

  @override
  Future<void> removeRepo({required String repoId}) async {
    removeCalls++;
    lastRepoId = repoId;
    if (errorToThrow != null) throw errorToThrow!;
  }

  @override
  Future<String> addRepo({required String githubUrl}) =>
      throw UnimplementedError();

  @override
  Future<({int added, int alreadyMembers, List<String> pending})>
      importCollaborators({required String repoId}) =>
          throw UnimplementedError();

  @override
  Future<List<SubTask>> breakdownTask({
    required String repoId,
    required String goal,
  }) =>
      throw UnimplementedError();

  @override
  Future<void> forceUnlockBreakdown({required String repoId}) =>
      throw UnimplementedError();

  @override
  Future<({String assigneeId, String reasoning})> assignTask({
    required String repoId,
    required String taskId,
  }) =>
      throw UnimplementedError();

  @override
  Future<String> generateHandoff({
    required String repoId,
    required String taskId,
    String? language,
    String? runId,
  }) =>
      throw UnimplementedError();

  @override
  Future<String> summarizeDay({
    required String repoId,
    required String startDate,
    String? endDate,
    String? language,
  }) =>
      throw UnimplementedError();

  @override
  Future<DailyBriefReply> dailyBrief({
    required String repoId,
    required String date,
    String? endDate,
    required String question,
    List<DailyBriefTurn> history = const [],
  }) =>
      throw UnimplementedError();

  @override
  Future<AskRepoReply> askRepo({
    required String repoId,
    required String question,
    List<AskRepoTurn> history = const [],
    String? runId,
  }) =>
      throw UnimplementedError();

  @override
  Future<String> explainCommit({
    required String repoId,
    required String sha,
    bool force = false,
    String? language,
    String? runId,
  }) =>
      throw UnimplementedError();

  @override
  Future<String> summarizeAuthorWork({
    required String repoId,
    String? login,
    List<String> names = const [],
    bool force = false,
  }) =>
      throw UnimplementedError();

  @override
  Future<CommitGraph> getCommitGraph({
    required String repoId,
    String? startDate,
    String? endDate,
    bool force = false,
  }) =>
      throw UnimplementedError();

  @override
  Future<void> setDiscordWebhook({
    required String repoId,
    required String webhookUrl,
    required List<String> channelIds,
  }) =>
      throw UnimplementedError();

  @override
  Future<String> requestDiscordFetch({
    required String repoId,
    required String date,
  }) =>
      throw UnimplementedError();

  @override
  Future<void> setDiscordStartDate({
    required String repoId,
    required String startDate,
  }) =>
      throw UnimplementedError();

  @override
  Future<void> setDiscordRange({
    required String repoId,
    required String startDate,
    required String endDate,
  }) =>
      throw UnimplementedError();

  @override
  Future<String> editDiscordDigest({
    required String repoId,
    required String date,
    required String instruction,
    String? runId,
  }) =>
      throw UnimplementedError();

  @override
  Future<void> setDigestLock({
    required String repoId,
    required String date,
    required bool locked,
  }) =>
      throw UnimplementedError();

  @override
  Future<DiscordChatReply> discordChat({
    required String repoId,
    required String question,
    List<DiscordChatTurn> history = const [],
    String? startDate,
    String? endDate,
    String? runId,
  }) =>
      throw UnimplementedError();

  @override
  Future<void> subscribeToTopic({
    required String token,
    required String topic,
  }) =>
      throw UnimplementedError();
}

void main() {
  group('RepoListViewModel.removeRepo', () {
    test('returns true and clears lastError on success', () async {
      final functions = _FakeFunctionsService();
      final vm = RepoListViewModel(
        userId: 'uid-1',
        repoRepository: _FakeRepoRepository(),
        functionsService: functions,
      );

      final ok = await vm.removeRepo('owner_repo');

      expect(ok, isTrue);
      expect(vm.lastError, isNull);
      expect(vm.isRemoving('owner_repo'), isFalse);
      expect(functions.removeCalls, 1);
      expect(functions.lastRepoId, 'owner_repo');
    });

    test('sets lastError and returns false when the callable throws', () async {
      final functions = _FakeFunctionsService(errorToThrow: Exception('boom'));
      final vm = RepoListViewModel(
        userId: 'uid-1',
        repoRepository: _FakeRepoRepository(),
        functionsService: functions,
      );

      final ok = await vm.removeRepo('owner_repo');

      expect(ok, isFalse);
      expect(vm.lastError, contains('boom'));
      expect(vm.isRemoving('owner_repo'), isFalse);
    });
  });
}
