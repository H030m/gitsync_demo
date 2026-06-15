import 'package:flutter_test/flutter_test.dart';

import 'package:gitsync/data/dummy_data.dart';
import 'package:gitsync/models/agent_run.dart';
import 'package:gitsync/models/ask_repo.dart';
import 'package:gitsync/repositories/agent_run_repo.dart';
import 'package:gitsync/services/fake/fake_functions_service.dart';
import 'package:gitsync/services/functions_service.dart';
import 'package:gitsync/view_models/ask_repo_vm.dart';

// Unit tests for AskRepoViewModel: ask() lifecycle (turns / sending / sources /
// error) and that a fresh runId is generated per ask and passed to both the
// callable and the trace stream. Uses a recording fake over the canned backend.

/// Records the runIds the VM passes in, delegating the answer to the fake.
class _RecordingFunctions implements FunctionsService {
  final _fake = FakeFunctionsService();
  final List<String?> runIds = [];

  @override
  Future<AskRepoReply> askRepo({
    required String repoId,
    required String question,
    List<AskRepoTurn> history = const [],
    String? runId,
  }) {
    runIds.add(runId);
    return _fake.askRepo(
      repoId: repoId,
      question: question,
      history: history,
      runId: runId,
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError(invocation.memberName.toString());
}

/// Records the runIds the VM subscribes to, emitting an empty done run.
class _RecordingAgentRuns implements AgentRunRepository {
  final List<String> watched = [];

  @override
  Stream<AgentRun?> watch(String repoId, String runId) async* {
    watched.add(runId);
    yield const AgentRun(status: 'done', steps: []);
  }
}

void main() {
  test('ask appends a user turn then an assistant turn with sources', () async {
    final vm = AskRepoViewModel(
      repoId: DummyData.demoRepoId,
      functionsService: FakeFunctionsService(),
      agentRunRepository: _RecordingAgentRuns(),
    );

    await vm.ask('今天有哪些 commit 跟 OAuth 有關？');

    expect(vm.turns.length, 2);
    expect(vm.turns.first.isUser, isTrue);
    expect(vm.turns.last.isUser, isFalse);
    expect(vm.turns.last.content, isNotEmpty);
    expect(vm.turns.last.commitGroups, isNotEmpty);
    expect(vm.sending, isFalse);
    expect(vm.liveSteps, isEmpty); // cleared after the answer resolves
  });

  test('empty input is a no-op', () async {
    final vm = AskRepoViewModel(
      repoId: DummyData.demoRepoId,
      functionsService: FakeFunctionsService(),
      agentRunRepository: _RecordingAgentRuns(),
    );
    await vm.ask('   ');
    expect(vm.turns, isEmpty);
  });

  test('a fresh runId is generated per ask and used for callable + trace',
      () async {
    final fns = _RecordingFunctions();
    final runs = _RecordingAgentRuns();
    final vm = AskRepoViewModel(
      repoId: DummyData.demoRepoId,
      functionsService: fns,
      agentRunRepository: runs,
    );

    await vm.ask('first');
    await vm.ask('second');

    expect(fns.runIds.length, 2);
    expect(fns.runIds[0], isNotNull);
    // Distinct runId per ask.
    expect(fns.runIds[0], isNot(fns.runIds[1]));
    // The same runId was used to subscribe to the trace stream.
    expect(runs.watched, equals(fns.runIds));
  });

  test('newSession clears the transcript (no-op while sending)', () async {
    final vm = AskRepoViewModel(
      repoId: DummyData.demoRepoId,
      functionsService: FakeFunctionsService(),
      agentRunRepository: _RecordingAgentRuns(),
    );
    await vm.ask('first question about OAuth');
    expect(vm.turns, isNotEmpty);

    vm.newSession();
    expect(vm.turns, isEmpty);
    expect(vm.error, isNull);
  });
}
