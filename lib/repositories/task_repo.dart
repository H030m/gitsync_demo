import 'package:cloud_firestore/cloud_firestore.dart';

import '../config/app_config.dart';
import '../models/task.dart';
import 'fake/fake_task_repo.dart';
import 'firestore_paths.dart';

abstract class TaskRepository {
  factory TaskRepository() => AppConfig.useFakeBackend
      ? FakeTaskRepository()
      : _LiveTaskRepository();

  Stream<List<Task>> streamTasks(String repoId);
  Stream<Task?> streamTask(String repoId, String taskId);
  Future<String> addTask(String repoId, Task task);
  Future<void> updateStatus(String repoId, String taskId, TaskStatus status);
  Future<void> assignTo(String repoId, String taskId, String? assigneeId);
  Future<void> updateDependsOn(
      String repoId, String taskId, List<String> dependsOn);
  Future<void> deleteTask(String repoId, String taskId);
  Future<List<Task>> getDependentsOf(String repoId, String taskId);
}

class _LiveTaskRepository implements TaskRepository {
  final FirebaseFirestore _db = FirebaseFirestore.instance;
  static const _timeout = Duration(seconds: 10);

  @override
  Stream<List<Task>> streamTasks(String repoId) {
    return _db
        .collection(FirestorePaths.tasks(repoId))
        .orderBy('createdAt', descending: true)
        .snapshots()
        .map((snap) => snap.docs
            .map((d) => Task.fromMap(d.data(), d.id))
            .toList());
  }

  @override
  Stream<Task?> streamTask(String repoId, String taskId) {
    return _db
        .doc('${FirestorePaths.tasks(repoId)}/$taskId')
        .snapshots()
        .map((snap) {
      final data = snap.data();
      if (data == null) return null;
      return Task.fromMap(data, snap.id);
    });
  }

  @override
  Future<String> addTask(String repoId, Task task) async {
    final map = task.toMap()
      ..['createdAt'] = FieldValue.serverTimestamp()
      ..['updatedAt'] = FieldValue.serverTimestamp();
    final ref = await _db
        .collection(FirestorePaths.tasks(repoId))
        .add(map)
        .timeout(_timeout);
    return ref.id;
  }

  @override
  Future<void> updateStatus(
    String repoId,
    String taskId,
    TaskStatus status,
  ) async {
    await _db.doc('${FirestorePaths.tasks(repoId)}/$taskId').update({
      'status': status.wire,
      'updatedAt': FieldValue.serverTimestamp(),
    }).timeout(_timeout);
  }

  @override
  Future<void> assignTo(
    String repoId,
    String taskId,
    String? assigneeId,
  ) async {
    await _db.doc('${FirestorePaths.tasks(repoId)}/$taskId').update({
      'assigneeId': assigneeId,
      'updatedAt': FieldValue.serverTimestamp(),
    }).timeout(_timeout);
  }

  @override
  Future<void> updateDependsOn(
    String repoId,
    String taskId,
    List<String> dependsOn,
  ) async {
    await _db.doc('${FirestorePaths.tasks(repoId)}/$taskId').update({
      'dependsOn': dependsOn,
      'updatedAt': FieldValue.serverTimestamp(),
    }).timeout(_timeout);
  }

  @override
  Future<void> deleteTask(String repoId, String taskId) async {
    await _db
        .doc('${FirestorePaths.tasks(repoId)}/$taskId')
        .delete()
        .timeout(_timeout);
  }

  @override
  Future<List<Task>> getDependentsOf(String repoId, String taskId) async {
    final snap = await _db
        .collection(FirestorePaths.tasks(repoId))
        .where('dependsOn', arrayContains: taskId)
        .get()
        .timeout(_timeout);
    return snap.docs.map((d) => Task.fromMap(d.data(), d.id)).toList();
  }
}
