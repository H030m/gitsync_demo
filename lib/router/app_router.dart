import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../config/app_config.dart';
import '../theme/app_motion.dart';
import '../view_models/commits_vm.dart';
import '../view_models/daily_brief_vm.dart';
import '../view_models/daily_report_vm.dart';
import '../view_models/discord_chat_vm.dart';
import '../view_models/discord_messages_vm.dart';
import '../view_models/ask_repo_vm.dart';
import '../view_models/intel_range_vm.dart';
import '../view_models/members_vm.dart';
import '../view_models/repo_vm.dart';
import '../view_models/tasks_board_vm.dart';
import '../views/daily/daily_view_page.dart';
import '../views/notify/notify_screen.dart';
import '../views/repos/add_repo_page.dart';
import '../views/repos/repo_list_page.dart';
import '../views/settings/settings_page.dart';
import '../views/shell/repo_shell.dart';
import '../views/sign_in/sign_in_page.dart';
import '../views/stats/stats_view_page.dart';
import '../views/tasks/add_todo_page.dart';
import '../views/tasks/task_details_page.dart';
import '../views/tasks/tasks_board_page.dart';
import 'shell_transitions.dart';

// Top-level GoRouter configuration. Matches ARCHITECTURE.md §3.
//
// `/repos/:repoId/...` lives under a ShellRoute that scopes the per-repo
// ViewModels (Tasks / Members / Commits / Discord / DailyReport) so child
// routes share the same stream subscriptions without re-creating them on
// every navigation.
final GoRouter appRouter = GoRouter(
  initialLocation: '/',
  debugLogDiagnostics: true,
  // In fake-backend mode the demo user is auto-signed-in at startup
  // (see [FakeAuthenticationService]), so we skip the sign-in screen and
  // land directly on the repo list. Live-mode sign-in is handled inside
  // [SignInPage] which calls `NavigationService.goRepos()` after success.
  redirect: (ctx, state) {
    if (AppConfig.useFakeBackend &&
        AppConfig.autoSignInDemoUser &&
        state.uri.path == '/') {
      return '/repos';
    }
    return null;
  },
  routes: <RouteBase>[
    GoRoute(
      path: '/',
      builder: (_, _) => const SignInPage(),
    ),
    GoRoute(
      path: '/repos',
      builder: (_, _) => const RepoListPage(),
      routes: [
        GoRoute(
          path: 'add',
          builder: (_, _) => const AddRepoPage(),
        ),
      ],
    ),
    ShellRoute(
      builder: (ctx, state, child) {
        final repoId = state.pathParameters['repoId'];
        if (repoId == null) {
          return Scaffold(
            body: Center(child: Text('Missing repoId in route ${state.uri}')),
          );
        }
        return MultiProvider(
          providers: [
            ChangeNotifierProvider(
              create: (_) => RepoViewModel(repoId: repoId),
            ),
            ChangeNotifierProvider(
              create: (_) => TasksBoardViewModel(repoId: repoId),
            ),
            ChangeNotifierProvider(
              create: (_) => MembersViewModel(repoId: repoId),
            ),
            ChangeNotifierProvider(
              create: (_) => CommitsViewModel(repoId: repoId),
            ),
            ChangeNotifierProvider(
              create: (_) => DiscordMessagesViewModel(repoId: repoId),
            ),
            ChangeNotifierProvider(
              create: (_) => DiscordChatViewModel(repoId: repoId),
            ),
            ChangeNotifierProvider(
              create: (_) => DailyReportViewModel(repoId: repoId),
            ),
            ChangeNotifierProvider(
              create: (_) => DailyBriefChatViewModel(repoId: repoId),
            ),
            // The global "Ask GitSync" chat VM — read by the repo-shell FAB and
            // its sheet on every tab, so they share one transcript.
            ChangeNotifierProvider(
              create: (_) => AskRepoViewModel(repoId: repoId),
            ),
            // One shared date range driving all three Daily tabs (see
            // IntelRangeViewModel). Scoped here so Tasks-page navigation
            // doesn't reset it.
            ChangeNotifierProvider(
              create: (_) => IntelRangeViewModel(),
            ),
          ],
          child: RepoShell(repoId: repoId, child: child),
        );
      },
      routes: [
        GoRoute(
          path: '/repos/:repoId/tasks',
          pageBuilder: (ctx, state) => CustomTransitionPage<void>(
            key: state.pageKey,
            transitionDuration: AppMotion.nav,
            reverseTransitionDuration: AppMotion.nav,
            transitionsBuilder: sharedAxisSlide,
            child: TasksBoardPage(
              repoId: state.pathParameters['repoId']!,
            ),
          ),
          routes: [
            GoRoute(
              path: 'add',
              builder: (_, state) => AddTodoPage(
                repoId: state.pathParameters['repoId']!,
              ),
            ),
            GoRoute(
              path: ':taskId',
              builder: (_, state) => TaskDetailsPage(
                repoId: state.pathParameters['repoId']!,
                taskId: state.pathParameters['taskId']!,
              ),
            ),
          ],
        ),
        GoRoute(
          path: '/repos/:repoId/daily',
          pageBuilder: (ctx, state) => CustomTransitionPage<void>(
            key: state.pageKey,
            transitionDuration: AppMotion.nav,
            reverseTransitionDuration: AppMotion.nav,
            transitionsBuilder: sharedAxisSlide,
            child: DailyViewPage(
              repoId: state.pathParameters['repoId']!,
            ),
          ),
        ),
        GoRoute(
          path: '/repos/:repoId/stats',
          pageBuilder: (ctx, state) => CustomTransitionPage<void>(
            key: state.pageKey,
            transitionDuration: AppMotion.nav,
            reverseTransitionDuration: AppMotion.nav,
            transitionsBuilder: sharedAxisSlide,
            child: StatsViewPage(
              repoId: state.pathParameters['repoId']!,
            ),
          ),
        ),
        GoRoute(
          path: '/repos/:repoId/settings',
          pageBuilder: (ctx, state) => CustomTransitionPage<void>(
            key: state.pageKey,
            transitionDuration: AppMotion.nav,
            reverseTransitionDuration: AppMotion.nav,
            transitionsBuilder: sharedAxisSlide,
            child: SettingsPage(
              repoId: state.pathParameters['repoId']!,
            ),
          ),
        ),
      ],
    ),
    GoRoute(
      path: '/notify',
      builder: (_, _) => const NotifyScreen(),
    ),
  ],
  errorBuilder: (_, state) => Scaffold(
    body: Center(child: Text('Not found: ${state.uri.path}')),
  ),
);
