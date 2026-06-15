import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

import '../router/app_router.dart';

// Wraps `GoRouter` in a service so Views never call `GoRouter.of(context)`
// directly. Views obtain this via `Provider.of<NavigationService>(...)`.
class NavigationService {
  late final GoRouter _router;

  NavigationService() {
    _router = appRouter;
  }

  GoRouter get router => _router;

  // ---- Top-level routes --------------------------------------------------

  void goSignIn() => _router.go('/');
  void goRepos() => _router.go('/repos');
  void goAddRepo() => _router.go('/repos/add');

  // ---- Repo-scoped routes ------------------------------------------------

  void goTasks(String repoId) => _router.go('/repos/$repoId/tasks');
  void goAddTodo(String repoId) => _router.go('/repos/$repoId/tasks/add');
  void goTaskDetails(String repoId, String taskId) =>
      _router.go('/repos/$repoId/tasks/$taskId');
  void goDaily(String repoId) => _router.go('/repos/$repoId/daily');
  void goStats(String repoId) => _router.go('/repos/$repoId/stats');
  void goSettings(String repoId) => _router.go('/repos/$repoId/settings');

  // ---- Other -------------------------------------------------------------

  void goNotify() => _router.go('/notify');

  void pop(BuildContext ctx) {
    if (_router.canPop()) {
      _router.pop();
    }
  }
}
