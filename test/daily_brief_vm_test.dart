import 'package:flutter_test/flutter_test.dart';
import 'package:gitsync/data/dummy_data.dart';
import 'package:gitsync/services/fake/fake_functions_service.dart';
import 'package:gitsync/view_models/daily_brief_vm.dart';

// Exercises DailyBriefChatViewModel against the real fake FunctionsService, so
// the keyword-match → sources path is covered end-to-end without a hand-rolled
// mock.
void main() {
  DailyBriefChatViewModel makeVm() => DailyBriefChatViewModel(
        repoId: DummyData.demoRepoId,
        functionsService: FakeFunctionsService(),
      );

  test('ask appends a user turn then an assistant turn with sources', () async {
    final vm = makeVm();

    await vm.ask('今天有哪些 commit 跟 OAuth 有關？');

    expect(vm.turns.length, 2);
    expect(vm.turns.first.isUser, isTrue);
    expect(vm.turns.last.isUser, isFalse);
    expect(vm.turns.last.content, isNotEmpty);
    // The fake cites the matching demo commit(s) as sources.
    expect(vm.turns.last.sources, isNotEmpty);
    expect(vm.sending, isFalse);
  });

  test('empty input is a no-op', () async {
    final vm = makeVm();
    await vm.ask('   ');
    expect(vm.turns, isEmpty);
  });

  test('history is passed as prior turns on a follow-up', () async {
    final vm = makeVm();
    await vm.ask('first question about OAuth');
    await vm.ask('and the breakdownTask schema?');
    // Two round-trips → four turns, alternating user/assistant.
    expect(vm.turns.length, 4);
    expect(vm.turns[0].isUser, isTrue);
    expect(vm.turns[1].isUser, isFalse);
    expect(vm.turns[2].isUser, isTrue);
    expect(vm.turns[3].isUser, isFalse);
  });
}
