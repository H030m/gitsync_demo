import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:gitsync/models/repo.dart';
import 'package:gitsync/models/task.dart';
import 'package:gitsync/repositories/repo_repo.dart';
import 'package:gitsync/repositories/task_repo.dart';
import 'package:gitsync/services/navigation.dart';
import 'package:gitsync/view_models/members_vm.dart';
import 'package:gitsync/view_models/repo_vm.dart';
import 'package:gitsync/view_models/tasks_board_vm.dart';
import 'package:gitsync/views/tasks/task_details_page.dart';

// In-test fake task repo (mirrors test/tasks_board_test.dart): isolated task
// list, captures the last updateStatus call, re-emits the updated list so the
// page's stream-driven UI refreshes. Unstubbed methods throw.
class _StubTaskRepo implements TaskRepository {
  _StubTaskRepo(List<Task> seed) : _tasks = List.of(seed);

  List<Task> _tasks;
  final _controller = StreamController<List<Task>>.broadcast();

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

// Repo stream stub: the page only reads `repo?.url` (GitHub link chips); a
// null repo keeps those chips non-tappable, which is fine here.
class _StubRepoRepo implements RepoRepository {
  @override
  Stream<Repo?> streamRepo(String repoId) => Stream.value(null);

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName} not stubbed');
}

Widget _harness(_StubTaskRepo repo) {
  return MaterialApp(
    home: MultiProvider(
      providers: [
        Provider<NavigationService>(create: (_) => NavigationService()),
        ChangeNotifierProvider<TasksBoardViewModel>(
          create: (_) =>
              TasksBoardViewModel(repoId: 'r1', taskRepository: repo),
        ),
        ChangeNotifierProvider<MembersViewModel>(
          create: (_) => MembersViewModel(repoId: 'r1'),
        ),
        ChangeNotifierProvider<RepoViewModel>(
          create: (_) =>
              RepoViewModel(repoId: 'r1', repoRepository: _StubRepoRepo()),
        ),
      ],
      child: const TaskDetailsPage(repoId: 'r1', taskId: 't1'),
    ),
  );
}

Task _task(String id, String title, TaskStatus status) => Task(
      id: id,
      title: title,
      status: status,
      createdBy: 'u1',
    );

void main() {
  testWidgets(
      'tapping the status chip opens the picker and selecting a status '
      'updates the task', (tester) async {
    final repo = _StubTaskRepo([_task('t1', 'Alpha', TaskStatus.todo)]);
    await tester.pumpWidget(_harness(repo));
    await tester.pumpAndSettle();

    // The main task's chip shows the wire status.
    expect(find.text('todo'), findsOneWidget);
    await tester.tap(find.text('todo'));
    await tester.pumpAndSettle();

    // Picker sheet: title + the three localized status options.
    expect(find.text('變更狀態'), findsOneWidget);
    expect(find.text('待辦'), findsOneWidget);
    expect(find.text('進行中'), findsOneWidget);
    expect(find.text('完成'), findsOneWidget);

    await tester.tap(find.text('進行中'));
    await tester.pumpAndSettle();

    expect(repo.lastUpdatedId, 't1');
    expect(repo.lastUpdatedStatus, TaskStatus.inProgress);
    // Stream pushed the update back: the chip now reflects the new status.
    expect(find.text('in_progress'), findsOneWidget);
    expect(find.text('變更狀態'), findsNothing);
  });

  testWidgets('selecting the current status from the chip writes nothing',
      (tester) async {
    final repo = _StubTaskRepo([_task('t1', 'Alpha', TaskStatus.todo)]);
    await tester.pumpWidget(_harness(repo));
    await tester.pumpAndSettle();

    await tester.tap(find.text('todo'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('待辦'));
    await tester.pumpAndSettle();

    expect(repo.lastUpdatedId, isNull);
    expect(repo.lastUpdatedStatus, isNull);
  });
}
