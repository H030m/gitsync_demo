import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:gitsync/models/task.dart';
import 'package:gitsync/repositories/task_repo.dart';
import 'package:gitsync/services/navigation.dart';
import 'package:gitsync/view_models/members_vm.dart';
import 'package:gitsync/view_models/tasks_board_vm.dart';
import 'package:gitsync/views/tasks/tasks_board_page.dart';

// In-test fake so each case gets an isolated, fully-controlled task list (the
// app's FakeTaskRepository is a shared singleton seeded with demo data). Only
// the methods the board exercises are implemented; the rest throw.
class _StubTaskRepo implements TaskRepository {
  _StubTaskRepo(List<Task> seed) : _tasks = List.of(seed);

  List<Task> _tasks;
  final _controller = StreamController<List<Task>>.broadcast();

  // Captures the last updateStatus call so a test can assert the drag wrote.
  String? lastUpdatedId;
  TaskStatus? lastUpdatedStatus;

  @override
  Stream<List<Task>> streamTasks(String repoId) async* {
    yield _tasks;
    yield* _controller.stream;
  }

  @override
  Future<void> updateStatus(
      String repoId, String taskId, TaskStatus status) async {
    lastUpdatedId = taskId;
    lastUpdatedStatus = status;
    _tasks = _tasks
        .map((t) => t.id == taskId ? _withStatus(t, status) : t)
        .toList();
    _controller.add(_tasks);
  }

  static Task _withStatus(Task t, TaskStatus status) => Task(
        id: t.id,
        title: t.title,
        description: t.description,
        status: status,
        assigneeId: t.assigneeId,
        dependsOn: t.dependsOn,
        source: t.source,
        createdBy: t.createdBy,
      );

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName} not stubbed');
}

// Records goTaskDetails calls so tests can assert row-tap navigation without a
// real router pumping.
class _StubNav extends NavigationService {
  String? detailsRepoId;
  String? detailsTaskId;

  @override
  void goTaskDetails(String repoId, String taskId) {
    detailsRepoId = repoId;
    detailsTaskId = taskId;
  }
}

Widget _harness(_StubTaskRepo repo, {NavigationService? nav}) {
  return MaterialApp(
    home: MultiProvider(
      providers: [
        Provider<NavigationService>(create: (_) => nav ?? NavigationService()),
        ChangeNotifierProvider<TasksBoardViewModel>(
          create: (_) =>
              TasksBoardViewModel(repoId: 'r1', taskRepository: repo),
        ),
        ChangeNotifierProvider<MembersViewModel>(
          create: (_) => MembersViewModel(repoId: 'r1'),
        ),
      ],
      child: const TasksBoardPage(repoId: 'r1'),
    ),
  );
}

Task _task(
  String id,
  String title,
  TaskStatus status, {
  String? assignee,
}) =>
    Task(
      id: id,
      title: title,
      status: status,
      assigneeId: assignee,
      createdBy: 'u1',
    );

// Pump the board at a chosen logical surface size so layout-mode tests are
// deterministic regardless of the host's default test window.
Future<void> _pumpAt(WidgetTester tester, Widget app, Size size) async {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = size;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(app);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('columns render CJK labels and count chips matching task counts',
      (tester) async {
    final repo = _StubTaskRepo([
      _task('t1', 'Alpha', TaskStatus.todo),
      _task('t2', 'Beta', TaskStatus.todo),
      _task('t3', 'Gamma', TaskStatus.inProgress),
      _task('t4', 'Delta', TaskStatus.done),
    ]);
    await tester.pumpWidget(_harness(repo));
    await tester.pumpAndSettle();

    // Tabs + column labels (CJK).
    expect(find.text('看板'), findsOneWidget);
    expect(find.text('關聯圖'), findsOneWidget);
    expect(find.text('待辦'), findsOneWidget);
    expect(find.text('進行中'), findsOneWidget);
    expect(find.text('完成'), findsOneWidget);

    // Count chips reflect column sizes: todo=2, inProgress=1, done=1.
    expect(find.text('2'), findsOneWidget);
    expect(find.text('1'), findsNWidgets(2));

    // Cards show their titles.
    expect(find.text('Alpha'), findsOneWidget);
    expect(find.text('Gamma'), findsOneWidget);
  });

  testWidgets('long-press dragging a card to another column updates its status',
      (tester) async {
    final repo = _StubTaskRepo([
      _task('t1', 'Movable', TaskStatus.todo),
      _task('t3', 'Holder', TaskStatus.inProgress),
    ]);
    await tester.pumpWidget(_harness(repo));
    await tester.pumpAndSettle();

    final cardFinder = find.text('Movable');
    final targetFinder = find.text('進行中');
    expect(cardFinder, findsOneWidget);

    // LongPressDraggable needs a long-press delay before it picks up: start a
    // gesture, hold, then move onto the 進行中 column and release.
    final gesture =
        await tester.startGesture(tester.getCenter(cardFinder));
    await tester.pump(const Duration(milliseconds: 600));
    await gesture.moveTo(tester.getCenter(targetFinder));
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();

    expect(repo.lastUpdatedId, 't1');
    expect(repo.lastUpdatedStatus, TaskStatus.inProgress);
  });

  testWidgets('empty-state copy shows when there are no tasks', (tester) async {
    final repo = _StubTaskRepo(const []);
    await tester.pumpWidget(_harness(repo));
    await tester.pumpAndSettle();

    expect(find.text('您還未輸入專案架構'), findsOneWidget);
    expect(find.text('請點擊右下角 + 號來新增任務'), findsOneWidget);
    // No column headers render in the empty state.
    expect(find.text('待辦'), findsNothing);
  });

  testWidgets('wide surface uses fill mode (no horizontal scroll)',
      (tester) async {
    final repo = _StubTaskRepo([
      _task('t1', 'Alpha', TaskStatus.todo),
      _task('t2', 'Gamma', TaskStatus.inProgress),
    ]);
    await _pumpAt(tester, _harness(repo), const Size(1200, 2400));

    // Columns still render, but the board does not wrap them in a horizontal
    // scroll view in fill mode.
    expect(find.text('待辦'), findsOneWidget);
    final horizontalScrollables = find.byWidgetPredicate(
      (w) => w is SingleChildScrollView && w.scrollDirection == Axis.horizontal,
    );
    expect(horizontalScrollables, findsNothing);
  });

  // ---- Narrow layout: TickTick-style collapsible sections (task 06-13) ----

  testWidgets('narrow surface shows three section headers, no horizontal scroll',
      (tester) async {
    final repo = _StubTaskRepo([
      _task('t1', 'Alpha', TaskStatus.todo),
      _task('t2', 'Gamma', TaskStatus.inProgress),
      _task('t3', 'Omega', TaskStatus.done),
    ]);
    await _pumpAt(tester, _harness(repo), const Size(500, 800));

    // All three section headers render with their count chips (1 each).
    expect(find.text('待辦'), findsOneWidget);
    expect(find.text('進行中'), findsOneWidget);
    expect(find.text('完成'), findsOneWidget);
    expect(find.text('1'), findsNWidgets(3));

    // The horizontal-scrolling kanban is gone on narrow surfaces.
    final horizontalScrollables = find.byWidgetPredicate(
      (w) => w is SingleChildScrollView && w.scrollDirection == Axis.horizontal,
    );
    expect(horizontalScrollables, findsNothing);
  });

  testWidgets('default expansion: todo + inProgress rows visible, done hidden',
      (tester) async {
    final repo = _StubTaskRepo([
      _task('t1', 'Alpha', TaskStatus.todo),
      _task('t2', 'Gamma', TaskStatus.inProgress),
      _task('t3', 'Omega', TaskStatus.done),
    ]);
    await _pumpAt(tester, _harness(repo), const Size(500, 800));

    expect(find.text('Alpha'), findsOneWidget);
    expect(find.text('Gamma'), findsOneWidget);
    expect(find.text('Omega'), findsNothing);
  });

  testWidgets('tapping the done header expands then collapses its rows',
      (tester) async {
    final repo = _StubTaskRepo([
      _task('t1', 'Alpha', TaskStatus.todo),
      _task('t3', 'Omega', TaskStatus.done),
    ]);
    await _pumpAt(tester, _harness(repo), const Size(500, 800));
    expect(find.text('Omega'), findsNothing);

    await tester.tap(find.text('完成'));
    await tester.pumpAndSettle();
    expect(find.text('Omega'), findsOneWidget);

    await tester.tap(find.text('完成'));
    await tester.pumpAndSettle();
    expect(find.text('Omega'), findsNothing);
  });

  testWidgets("tapping a row's circle marks the task done", (tester) async {
    final repo = _StubTaskRepo([
      _task('t1', 'Alpha', TaskStatus.todo),
    ]);
    await _pumpAt(tester, _harness(repo), const Size(500, 800));

    await tester.tap(find.byIcon(Icons.radio_button_unchecked));
    await tester.pumpAndSettle();

    expect(repo.lastUpdatedId, 't1');
    expect(repo.lastUpdatedStatus, TaskStatus.done);
  });

  testWidgets(
      'long-pressing a row opens the status picker and choosing a status '
      'updates it', (tester) async {
    final repo = _StubTaskRepo([
      _task('t1', 'Alpha', TaskStatus.todo),
    ]);
    await _pumpAt(tester, _harness(repo), const Size(500, 800));

    await tester.longPress(find.text('Alpha'));
    await tester.pumpAndSettle();

    // The sheet shows its title plus all three options (the section headers
    // already display 待辦/進行中/完成 once each, hence two of each now).
    expect(find.text('變更狀態'), findsOneWidget);
    expect(find.text('待辦'), findsNWidgets(2));
    expect(find.text('進行中'), findsNWidgets(2));
    expect(find.text('完成'), findsNWidgets(2));

    // Pick 進行中 (not just done — arbitrary transitions are the point).
    await tester.tap(find.text('進行中').last);
    await tester.pumpAndSettle();

    expect(repo.lastUpdatedId, 't1');
    expect(repo.lastUpdatedStatus, TaskStatus.inProgress);
    // Sheet is gone and the row moved to the 進行中 section.
    expect(find.text('變更狀態'), findsNothing);
    expect(find.text('Alpha'), findsOneWidget);
  });

  testWidgets('picking the current status from the picker writes nothing',
      (tester) async {
    final repo = _StubTaskRepo([
      _task('t1', 'Alpha', TaskStatus.todo),
    ]);
    await _pumpAt(tester, _harness(repo), const Size(500, 800));

    await tester.longPress(find.text('Alpha'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('待辦').last);
    await tester.pumpAndSettle();

    expect(repo.lastUpdatedId, isNull);
    expect(repo.lastUpdatedStatus, isNull);
  });

  testWidgets('tapping a row navigates to task details', (tester) async {
    final repo = _StubTaskRepo([
      _task('t1', 'Alpha', TaskStatus.todo),
    ]);
    final nav = _StubNav();
    await _pumpAt(tester, _harness(repo, nav: nav), const Size(500, 800));

    await tester.tap(find.text('Alpha'));
    await tester.pumpAndSettle();

    expect(nav.detailsRepoId, 'r1');
    expect(nav.detailsTaskId, 't1');
  });
}
