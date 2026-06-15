import '../../config/app_config.dart';
import '../../data/dummy_data.dart';
import '../../models/task.dart';
import '../task_repo.dart';
import '_replay_state.dart';

class FakeTaskRepository implements TaskRepository {
  factory FakeTaskRepository() => _instance;
  FakeTaskRepository._internal();
  static final FakeTaskRepository _instance = FakeTaskRepository._internal();

  // Per-repo task list. Seeded with DummyData.tasks for the demo repo.
  late final Map<String, ReplayState<List<Task>>> _byRepo = {
    DummyData.demoRepoId: ReplayState<List<Task>>(DummyData.tasks),
  };

  int _idCounter = 100;

  ReplayState<List<Task>> _state(String repoId) =>
      _byRepo.putIfAbsent(repoId, () => ReplayState<List<Task>>(const []));

  @override
  Stream<List<Task>> streamTasks(String repoId) => _state(repoId).stream;

  @override
  Stream<Task?> streamTask(String repoId, String taskId) async* {
    yield _state(repoId)
        .value
        .where((t) => t.id == taskId)
        .firstOrNull;
    await for (final list in _state(repoId).stream) {
      yield list.where((t) => t.id == taskId).firstOrNull;
    }
  }

  @override
  Future<String> addTask(String repoId, Task task) async {
    await Future.delayed(AppConfig.simulatedLatency);
    final newId = 'fake-task-${(++_idCounter).toString().padLeft(3, '0')}';
    final newTask = Task(
      id: newId,
      title: task.title,
      description: task.description,
      status: task.status,
      assigneeId: task.assigneeId,
      dependsOn: task.dependsOn,
      githubIssueNumber: task.githubIssueNumber,
      linkedPRNumbers: task.linkedPRNumbers,
      acceptanceCriteria: task.acceptanceCriteria,
      handoffDoc: task.handoffDoc,
      handoffGeneratedAt: task.handoffGeneratedAt,
      source: task.source,
      parentTaskId: task.parentTaskId,
      createdBy: task.createdBy,
    );
    final state = _state(repoId);
    state.update([newTask, ...state.value]);
    return newId;
  }

  @override
  Future<void> updateStatus(
      String repoId, String taskId, TaskStatus status) async {
    await Future.delayed(AppConfig.simulatedLatency);
    final state = _state(repoId);
    state.update(state.value.map((t) {
      if (t.id != taskId) return t;
      return Task(
        id: t.id,
        title: t.title,
        description: t.description,
        status: status,
        assigneeId: t.assigneeId,
        dependsOn: t.dependsOn,
        githubIssueNumber: t.githubIssueNumber,
        linkedPRNumbers: t.linkedPRNumbers,
        acceptanceCriteria: t.acceptanceCriteria,
        handoffDoc: t.handoffDoc,
        handoffGeneratedAt: t.handoffGeneratedAt,
        source: t.source,
        parentTaskId: t.parentTaskId,
        createdBy: t.createdBy,
      );
    }).toList());
  }

  @override
  Future<void> assignTo(
      String repoId, String taskId, String? assigneeId) async {
    await Future.delayed(AppConfig.simulatedLatency);
    final state = _state(repoId);
    state.update(state.value.map((t) {
      if (t.id != taskId) return t;
      return Task(
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        assigneeId: assigneeId,
        dependsOn: t.dependsOn,
        githubIssueNumber: t.githubIssueNumber,
        linkedPRNumbers: t.linkedPRNumbers,
        acceptanceCriteria: t.acceptanceCriteria,
        handoffDoc: t.handoffDoc,
        handoffGeneratedAt: t.handoffGeneratedAt,
        source: t.source,
        parentTaskId: t.parentTaskId,
        createdBy: t.createdBy,
      );
    }).toList());
  }

  @override
  Future<void> updateDependsOn(
      String repoId, String taskId, List<String> dependsOn) async {
    await Future.delayed(AppConfig.simulatedLatency);
    final state = _state(repoId);
    state.update(state.value.map((t) {
      if (t.id != taskId) return t;
      return Task(
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        assigneeId: t.assigneeId,
        dependsOn: dependsOn,
        githubIssueNumber: t.githubIssueNumber,
        linkedPRNumbers: t.linkedPRNumbers,
        acceptanceCriteria: t.acceptanceCriteria,
        handoffDoc: t.handoffDoc,
        handoffGeneratedAt: t.handoffGeneratedAt,
        source: t.source,
        parentTaskId: t.parentTaskId,
        createdBy: t.createdBy,
      );
    }).toList());
  }

  @override
  Future<void> deleteTask(String repoId, String taskId) async {
    await Future.delayed(AppConfig.simulatedLatency);
    final state = _state(repoId);
    state.update(state.value.where((t) => t.id != taskId).toList());
  }

  @override
  Future<List<Task>> getDependentsOf(String repoId, String taskId) async {
    await Future.delayed(AppConfig.simulatedLatency);
    return _state(repoId)
        .value
        .where((t) => t.dependsOn.contains(taskId))
        .toList();
  }
}
