# Frontend Directory Structure (Flutter)

> "Frontend" = the Flutter app under `lib/`. Architecture is **MVVM, 5 layers**.
> Source of truth: [`COURSE_METHODS.md §0`](../../../docs/COURSE_METHODS.md),
> [`ARCHITECTURE.md §3`](../../../docs/ARCHITECTURE.md), [`AI_AGENT_RULES.md §3.1`](../../../docs/AI_AGENT_RULES.md).

---

## Real layout (`lib/`)

```
lib/
├── main.dart                 # MultiProvider + MaterialApp.router entry; auth StreamBuilder
├── firebase_options.dart     # gitignored; copy from firebase_options.example.dart
├── config/                   # app_config.dart — Backend.fake/live selection
├── models/                   # pure data classes with fromMap/toMap (task.dart, repo.dart, ...)
├── repositories/             # the ONLY layer that touches Firestore
│   └── fake/                 # in-memory Fake* implementations for BACKEND=fake
├── services/                 # cross-cutting: authentication, navigation, push_messaging,
│   │                         #   functions_service, theme_mode_notifier
│   └── fake/                 # Fake* service implementations
├── view_models/              # ChangeNotifier, one per screen (tasks_board_vm.dart, ...)
├── views/                    # full-screen Widgets grouped by feature (tasks/, daily/, ...)
├── router/                   # app_router.dart — GoRouter config
├── theme/                    # app_colors.dart, app_theme.dart
└── data/                     # static dummy data (dummy_data.dart)
```

> Note: the course layout also mentions `widgets/`, `state/`, `utils/`. They don't exist yet
> — create them only when first needed, following the same conventions.

---

## The 5-layer dependency direction (never violate)

```
View → ViewModel → Repository/Service → Firestore
```

- View: `Consumer<VM>` / `Provider.of<VM>(ctx, listen: false)`. **Never** imports
  `cloud_firestore` or `repositories/*`.
- ViewModel: `ChangeNotifier` from `package:flutter/foundation.dart`. **Never** imports
  `material.dart` or holds a `BuildContext`.
- Repository: the only layer touching Firestore; maps `DocumentSnapshot` → Model, never leaks it.

See [`component-guidelines.md`](./component-guidelines.md) (Views), [`state-management.md`](./state-management.md)
(ViewModels), [`hook-guidelines.md`](./hook-guidelines.md) (Models + Repositories — Flutter has no hooks).

---

## Fake / Live backend split (project-specific, important)

Every repository and backend-touching service is an **`abstract class` with a `factory`** that
returns a Fake or Live implementation based on `AppConfig.useFakeBackend`:

```dart
abstract class TaskRepository {
  factory TaskRepository() =>
      AppConfig.useFakeBackend ? FakeTaskRepository() : _LiveTaskRepository();
  Stream<List<Task>> streamTasks(String repoId);
  // ...
}
```

When you add a repository/service method, **add it to the abstract interface AND the Fake
implementation** (under `repositories/fake/` or `services/fake/`), or `BACKEND=fake` breaks.

---

## Naming ([`AI_AGENT_RULES.md §3.7`](../../../docs/AI_AGENT_RULES.md))

| Thing | Convention | Example |
|---|---|---|
| File | snake_case | `tasks_board_page.dart` |
| Page Widget | `XxxPage` | `TasksBoardPage` |
| ViewModel | `XxxViewModel` | `TasksBoardViewModel` |
| Repository | `XxxRepository` | `TaskRepository` |
| Service | `XxxService` | `NavigationService` |
| var / fn | camelCase | `streamTasks`, `assigneeId` |
