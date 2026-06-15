import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/task.dart';
import '../repositories/task_repo.dart';
import 'graph_edit_ops.dart';

// Streams every task in a repo (TasksBoardPage + TaskDetailsPage).
class TasksBoardViewModel with ChangeNotifier {
  TasksBoardViewModel({
    required String repoId,
    TaskRepository? taskRepository,
  })  : _repoId = repoId,
        _repo = taskRepository ?? TaskRepository() {
    _sub = _repo.streamTasks(_repoId).listen((tasks) {
      _tasks = tasks;
      _loading = false;
      notifyListeners();
    });
  }

  final String _repoId;
  final TaskRepository _repo;
  StreamSubscription<List<Task>>? _sub;

  List<Task> _tasks = [];
  List<Task> get tasks => _tasks;
  String get repoId => _repoId;

  bool _loading = true;
  bool get loading => _loading;

  // ---- Status groupings (consumed by the kanban board) -------------------

  List<Task> get todo =>
      _tasks.where((t) => t.status == TaskStatus.todo).toList();
  List<Task> get inProgress =>
      _tasks.where((t) => t.status == TaskStatus.inProgress).toList();
  List<Task> get done =>
      _tasks.where((t) => t.status == TaskStatus.done).toList();

  // ---- Mutations ---------------------------------------------------------

  Future<void> updateStatus(String taskId, TaskStatus status) async {
    await _repo.updateStatus(_repoId, taskId, status);
  }

  Future<void> assignTo(String taskId, String? assigneeId) async {
    await _repo.assignTo(_repoId, taskId, assigneeId);
  }

  Future<String> addTask(Task task) async {
    return _repo.addTask(_repoId, task);
  }

  Future<void> deleteTask(String taskId) async {
    await _repo.deleteTask(_repoId, taskId);
  }

  // ---- Dependency-graph editing -----------------------------------------

  Map<String, List<String>> _depsMap() => {
        for (final t in _tasks) t.id: t.dependsOn,
      };

  Task? _taskById(String id) {
    for (final t in _tasks) {
      if (t.id == id) return t;
    }
    return null;
  }

  /// Adds "[dependentId] depends on [prereqId]". Returns false without writing
  /// when it would self-link, the edge already exists, or it would create a
  /// cycle in the dependency DAG.
  Future<bool> addDependency(String dependentId, String prereqId) async {
    if (dependentId == prereqId) return false;
    final dependent = _taskById(dependentId);
    if (dependent == null || _taskById(prereqId) == null) return false;
    if (dependent.dependsOn.contains(prereqId)) return false;
    if (wouldCreateCycle(_depsMap(), dependentId, prereqId)) return false;
    await _repo.updateDependsOn(_repoId, dependentId, [
      ...dependent.dependsOn,
      prereqId,
    ]);
    return true;
  }

  /// Removes the prerequisite [prereqId] from [dependentId]'s dependencies.
  Future<void> removeDependency(String dependentId, String prereqId) async {
    final dependent = _taskById(dependentId);
    if (dependent == null || !dependent.dependsOn.contains(prereqId)) return;
    final next = [...dependent.dependsOn]..remove(prereqId);
    await _repo.updateDependsOn(_repoId, dependentId, next);
  }

  /// Deletes [taskId], bridging its prerequisites onto its dependents so the
  /// dependency chain isn't broken (DAG contraction — stays acyclic).
  Future<void> deleteTaskBridging(String taskId) async {
    final changes = bridgeOnDelete(_depsMap(), taskId);
    for (final entry in changes.entries) {
      await _repo.updateDependsOn(_repoId, entry.key, entry.value);
    }
    await _repo.deleteTask(_repoId, taskId);
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}
