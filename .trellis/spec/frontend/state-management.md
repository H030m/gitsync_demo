# State Management

> Single solution: **`provider` 6.x + `ChangeNotifier`**. No Riverpod / Bloc / GetX
> (course-mandated, [`AI_AGENT_RULES.md §3.5`](../../../docs/AI_AGENT_RULES.md)).
> Source: [`COURSE_METHODS.md §1`](../../../docs/COURSE_METHODS.md).

---

## ViewModel pattern (one per screen)

A ViewModel is a `ChangeNotifier` that subscribes to a repository stream and exposes plain
getters. Real example (`lib/view_models/tasks_board_vm.dart`):

```dart
class TasksBoardViewModel with ChangeNotifier {
  TasksBoardViewModel({required String repoId, TaskRepository? taskRepository})
      : _repoId = repoId,
        _repo = taskRepository ?? TaskRepository() {        // default to the factory
    _sub = _repo.streamTasks(_repoId).listen((tasks) {
      _tasks = tasks;
      _loading = false;
      notifyListeners();                                    // notify UI
    });
  }

  final TaskRepository _repo;
  StreamSubscription<List<Task>>? _sub;
  List<Task> _tasks = [];
  List<Task> get tasks => _tasks;

  // Derived state is a getter, not stored:
  List<Task> get todo => _tasks.where((t) => t.status == TaskStatus.todo).toList();

  Future<void> updateStatus(String taskId, TaskStatus status) =>
      _repo.updateStatus(_repoId, taskId, status);

  @override
  void dispose() {
    _sub?.cancel();                                         // ALWAYS cancel
    super.dispose();
  }
}
```

Rules:
- Inject the repository via constructor (`TaskRepository? x`), default to `x ?? TaskRepository()`
  — this makes the Fake/Live factory and testing both work.
- **Never** import `material.dart` or hold a `BuildContext`. `ChangeNotifier` comes from
  `package:flutter/foundation.dart`.
- **Always** `cancel()` every `StreamSubscription` in `dispose()`.
- Derived values are computed getters, not duplicated fields.
- Don't swallow errors here — let mutations throw so the View can show a snackbar.

---

## Registering providers

- Register in `main.dart` (`MultiProvider`) for app-global state, or in a `ShellRoute` of
  `lib/router/app_router.dart` for state scoped to a route subtree (so it isn't rebuilt on
  child navigation).
- Use `ChangeNotifierProxyProvider` when one ViewModel depends on another's state
  (`update:` feeds the new value in).

---

## State categories

| Kind | Where |
|---|---|
| Server state (Firestore) | ViewModel subscribed to a repository `Stream` |
| Screen UI state (loading flags, form values) | inside the View's `State` or the ViewModel |
| App-global (auth, theme) | `AuthViewModel`, `ThemeModeNotifier` registered in `main.dart` |
| Local-only prefs | `SharedPreferences` via a notifier (e.g. theme mode) |

ViewModel ↔ screen mapping is tabulated in [`ARCHITECTURE.md §3`](../../../docs/ARCHITECTURE.md).

---

## Common mistakes

- Calling `Provider.of(listen: true)` inside a callback (use `listen: false`).
- Forgetting `_sub?.cancel()` in `dispose()` → leaks + "setState after dispose".
- Storing derived state and letting it drift out of sync with the source list.
