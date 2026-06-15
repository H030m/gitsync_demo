# Data Layer: Models & Repositories

> **Flutter has no "hooks."** This file repurposes the hook slot to document the data layer —
> Models and Repositories — which is where shared stateful/data-fetching logic lives.
> Source: [`COURSE_METHODS.md §4`](../../../docs/COURSE_METHODS.md).

---

## Models (`lib/models/`)

Pure data classes, hand-written `fromMap` / `toMap` (no `freezed` / `json_serializable`).
Conventions from `lib/models/task.dart`:

- A **public constructor** for View/ViewModel creation, and a **private `Xxx._(...)`**
  constructor used by `fromMap` (carries `id` + server timestamps).
- Wire enums use an extension with `.wire` (serialize) and `fromWire` (parse, with a default):
  ```dart
  enum TaskStatus { todo, inProgress, done }
  extension TaskStatusX on TaskStatus {
    String get wire => switch (this) { /* ... */ TaskStatus.inProgress => 'in_progress', /* ... */ };
    static TaskStatus fromWire(String? s) => switch (s) { 'in_progress' => TaskStatus.inProgress, _ => TaskStatus.todo };
  }
  ```
- `Timestamp?` backing field + a non-null getter with a fallback:
  `Timestamp get createdAt => _createdAt ?? Timestamp.now();`
- `fromMap` defends against nulls/types (`map['title'] as String? ?? ''`,
  `List<String>.from(map['dependsOn'] as List? ?? [])`).
- `toMap` omits null optionals (`if (assigneeId != null) 'assigneeId': assigneeId`).
- Equality by `id`: override `==` and `hashCode`.
- Field names match the Firestore schema in [`ARCHITECTURE.md §2`](../../../docs/ARCHITECTURE.md) exactly.

---

## Repositories (`lib/repositories/`)

The **only** layer that touches Firestore. Pattern from `lib/repositories/task_repo.dart`:

- Declared as an `abstract class` with a `factory` switching Fake/Live on
  `AppConfig.useFakeBackend`. The Live impl is a private `_LiveXxxRepository`.
- Build paths from `FirestorePaths` (`firestore_paths.dart`), never inline strings.
- Return `Stream<List<Model>>` / `Future<T>`; map snapshots to Models — **never leak
  `DocumentSnapshot`** upward.
- Reads: `.snapshots().map((snap) => snap.docs.map((d) => Model.fromMap(d.data(), d.id)).toList())`.
- Writes: add `.timeout(const Duration(seconds: 10))`; set server timestamps via
  `FieldValue.serverTimestamp()`; use `runTransaction` for read-modify-write.
- **Do NOT catch errors here** — let them propagate so the View shows them. (Adding the timeout
  is fine; swallowing the exception is not.)

```dart
@override
Future<String> addTask(String repoId, Task task) async {
  final map = task.toMap()
    ..['createdAt'] = FieldValue.serverTimestamp()
    ..['updatedAt'] = FieldValue.serverTimestamp();
  final ref = await _db.collection(FirestorePaths.tasks(repoId)).add(map).timeout(_timeout);
  return ref.id;
}
```

---

## Keep Fake implementations in sync (critical)

Every method you add to a repository/service interface must also be implemented under
`repositories/fake/` (or `services/fake/`) using `dummy_data.dart` + `AppConfig.simulatedLatency`.
Skipping this breaks `flutter run --dart-define=BACKEND=fake`, which is the default dev path.

---

## Common mistakes

- Inline collection-path strings instead of `FirestorePaths`.
- Leaking `DocumentSnapshot`/`Map` past the repository.
- `try/catch` that swallows a write failure in the repository.
- Forgetting the Fake implementation for a new method.
