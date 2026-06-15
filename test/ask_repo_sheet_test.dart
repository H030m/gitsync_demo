import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:gitsync/data/dummy_data.dart';
import 'package:gitsync/models/agent_run.dart';
import 'package:gitsync/repositories/agent_run_repo.dart';
import 'package:gitsync/services/fake/fake_functions_service.dart';
import 'package:gitsync/view_models/ask_repo_vm.dart';
import 'package:gitsync/views/ask/ask_repo_sheet.dart';

// Widget + VM tests for the unified "Ask GitSync" chat. A minimal widget tree
// (NO main.dart / firebase_options import) backed by the fake FunctionsService
// and a scripted AgentRunRepository, so the trace-then-answer flow is covered
// offline. Mirrors daily_discord_tab_test's harness/new-session style.

const _repoId = DummyData.demoRepoId;

/// Emits a controllable trace stream so the test can assert that live steps
/// render BEFORE the (fake) answer resolves, without timing flakiness.
class _ScriptedAgentRuns implements AgentRunRepository {
  @override
  Stream<AgentRun?> watch(String repoId, String runId) async* {
    yield null;
    yield const AgentRun(status: 'running', steps: [
      AgentStep(label: 'Reading .trellis planning docs…'),
    ]);
    yield const AgentRun(status: 'running', steps: [
      AgentStep(label: 'Reading .trellis planning docs…'),
      AgentStep(label: 'Searching commit history…'),
    ]);
  }
}

AskRepoViewModel _makeVm({AgentRunRepository? agentRuns}) => AskRepoViewModel(
      repoId: _repoId,
      functionsService: FakeFunctionsService(),
      agentRunRepository: agentRuns ?? _ScriptedAgentRuns(),
    );

Widget _harness(AskRepoViewModel vm, {ThemeMode mode = ThemeMode.light}) {
  return MaterialApp(
    theme: ThemeData(colorSchemeSeed: Colors.indigo, brightness: Brightness.light),
    darkTheme:
        ThemeData(colorSchemeSeed: Colors.indigo, brightness: Brightness.dark),
    themeMode: mode,
    home: ChangeNotifierProvider.value(
      value: vm,
      child: Scaffold(
        body: Builder(
          builder: (ctx) => Center(
            child: ElevatedButton(
              onPressed: () =>
                  AskRepoSheet.show(ctx, ctx.read<AskRepoViewModel>()),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
}

void main() {
  Future<void> tall(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  testWidgets('opens the sheet, shows live trace steps, then answer + sources',
      (tester) async {
    await tall(tester);
    final vm = _makeVm();
    await tester.pumpWidget(_harness(vm));

    // Open the sheet.
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('問 GitSync'), findsOneWidget);

    // Ask a question that matches a demo commit + Discord message.
    final field = find.byType(TextField);
    await tester.enterText(field, 'OAuth 進度?');
    await tester.testTextInput.receiveAction(TextInputAction.send);

    // Pump (without settling) so the in-flight trace steps render.
    await tester.pump(); // user turn + sending
    await tester.pump(const Duration(milliseconds: 10)); // first trace emits
    expect(find.text('OAuth 進度?'), findsOneWidget);
    // Trace step labels are localized for display (no LocaleNotifier → zhHant).
    expect(find.text('讀取 .trellis 規劃文件…'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 10));
    expect(find.text('搜尋 commit 歷史…'), findsOneWidget);

    // Let the fake callable resolve (simulatedLatency * 5 = ~1.25s) → assistant
    // turn with sources. Pump explicit frames past the delay rather than
    // pumpAndSettle (the in-flight spinner never "settles").
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 300));
    }
    // Trace strip is gone once sending completes.
    expect(find.text('讀取 .trellis 規劃文件…'), findsNothing);
    // The assistant answer + at least one commit-sources panel are shown (the
    // panels are now per-author windows, headed by name rather than a count).
    expect(find.textContaining('示範回覆'), findsOneWidget);
    expect(find.byIcon(Icons.commit_outlined), findsWidgets);
    expect(vm.turns.length, 2);
    expect(vm.turns.last.isUser, isFalse);
    expect(vm.turns.last.commitGroups, isNotEmpty);
  });

  testWidgets('new-session button clears the transcript', (tester) async {
    await tall(tester);
    final vm = _makeVm();
    await tester.pumpWidget(_harness(vm));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'OAuth?');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 300));
    }
    expect(find.text('OAuth?'), findsOneWidget);

    await tester.tap(find.byTooltip('開啟新 session'));
    await tester.pump();
    expect(find.text('OAuth?'), findsNothing);
    expect(vm.turns, isEmpty);
  });

  testWidgets('renders without crashing in dark mode (style smoke)',
      (tester) async {
    await tall(tester);
    final vm = _makeVm();
    await tester.pumpWidget(_harness(vm, mode: ThemeMode.dark));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('問 GitSync'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
