import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:gitsync/data/dummy_data.dart';
import 'package:gitsync/l10n/app_locale.dart';
import 'package:gitsync/view_models/ask_repo_vm.dart';
import 'package:gitsync/view_models/commits_vm.dart';
import 'package:gitsync/view_models/daily_brief_vm.dart';
import 'package:gitsync/view_models/daily_report_vm.dart';
import 'package:gitsync/view_models/discord_chat_vm.dart';
import 'package:gitsync/view_models/discord_messages_vm.dart';
import 'package:gitsync/view_models/intel_range_vm.dart';
import 'package:gitsync/views/daily/daily_view_page.dart';

import '_helpers/locale.dart';

// Renders the real Commits tab (tree map) against the fake backend, drives the
// range filter and the tap-a-commit → AI work summary sheet.
//
// The widget tests in this file look for English UI strings (e.g. the
// "Commits" tab label). Since the upstream i18n switch (`5b7e562`) made the
// default UI language Traditional Chinese, every `_harness()` here pins the
// locale to English via [pinLocale] so finders match the strings the tests
// were authored against.
Widget _harness() {
  const repoId = DummyData.demoRepoId;
  // [pinLocale] wraps the MaterialApp itself (rather than its `home`) so the
  // `LocaleNotifier` provider sits ABOVE MaterialApp's Navigator — that way
  // routes pushed by `showModalBottomSheet` (e.g. the commit-detail sheet)
  // also resolve `context.l10n` to the pinned English locale.
  return pinLocale(
    AppLocale.en,
    child: MaterialApp(
      home: MultiProvider(
        providers: [
          ChangeNotifierProvider(create: (_) => CommitsViewModel(repoId: repoId)),
          ChangeNotifierProvider(
              create: (_) => DiscordMessagesViewModel(repoId: repoId)),
          ChangeNotifierProvider(
              create: (_) => DiscordChatViewModel(repoId: repoId)),
          ChangeNotifierProvider(
              create: (_) => DailyReportViewModel(repoId: repoId)),
          ChangeNotifierProvider(
              create: (_) => DailyBriefChatViewModel(repoId: repoId)),
          // The Summary tab's chat now reads the shared, repo-wide AskRepoViewModel.
          ChangeNotifierProvider(create: (_) => AskRepoViewModel(repoId: repoId)),
          ChangeNotifierProvider(create: (_) => IntelRangeViewModel()),
        ],
        child: const DailyViewPage(repoId: repoId),
      ),
    ),
  );
}

Future<void> _openCommitsTab(WidgetTester tester) async {
  await tester.pumpWidget(_harness());
  await tester.pumpAndSettle();
  await tester.tap(find.text('Commits'));
  await tester.pumpAndSettle();
}

/// The branch graph is the default visualization — these list tests flip the
/// toggle to the flat, filterable list view first.
Future<void> _switchToListView(WidgetTester tester) async {
  await tester.tap(find.byIcon(Icons.view_list_outlined));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('Commits list view renders commits with day headers',
      (tester) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await _openCommitsTab(tester);
    await _switchToListView(tester);

    expect(find.text('Commit map'), findsOneWidget);
    // All five dummy commits are on screen, grouped under day headers.
    expect(
        find.text('TaskBoard drag-and-drop between columns'), findsOneWidget);
    expect(find.text('Wire up GitHub OAuth provider in AuthService'),
        findsOneWidget);
    // The commits span multiple days → at least two day-header rows. (The
    // exact count depends on the wall clock vs the staggered dummy offsets.)
    final headerPattern = RegExp(r'^\d{4}-\d{2}-\d{2}$');
    expect(
      find.byWidgetPredicate(
          (w) => w is Text && headerPattern.hasMatch(w.data ?? '')),
      findsAtLeastNWidgets(2),
    );
  });

  testWidgets('tapping a list commit opens the sheet with an AI work summary',
      (tester) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await _openCommitsTab(tester);
    await _switchToListView(tester);

    await tester.tap(find.text('TaskBoard drag-and-drop between columns'));
    await tester.pumpAndSettle();

    expect(find.text('AI work summary'), findsOneWidget);
    // The fake explainCommit returns markdown grounded in the commit.
    expect(
      find.textContaining('Kanban columns', findRichText: true),
      findsWidgets,
    );
  });

  testWidgets('author filter narrows the list to the picked author',
      (tester) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await _openCommitsTab(tester);
    await _switchToListView(tester);

    // Open the Author multi-select and pick alice-dev only.
    await tester.tap(find.widgetWithText(FilterChip, 'Author'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('alice-dev'));
    await tester.pumpAndSettle();
    // Close the sheet.
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();

    // Alice's commits stay; demo-user / bob-ml commits are filtered out.
    expect(find.text('Wire up GitHub OAuth provider in AuthService'),
        findsOneWidget);
    expect(
        find.text('TaskBoard drag-and-drop between columns'), findsNothing);
    expect(find.text('breakdownTask: zod schema + cycle detection draft'),
        findsNothing);
  });

  testWidgets('keyword filter narrows the list (and composes with author)',
      (tester) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await _openCommitsTab(tester);
    await _switchToListView(tester);
    final vm =
        tester.element(find.text('Commit map')).read<CommitsViewModel>();

    // Keyword alone: only the two OAuth commits match.
    await tester.enterText(
        find.widgetWithText(TextField, 'Search message…'), 'OAuth');
    await tester.pumpAndSettle();
    expect(find.text('Wire up GitHub OAuth provider in AuthService'),
        findsOneWidget);
    expect(
        find.text('OAuth callback URL fix for Windows + sign-in error states'),
        findsOneWidget);
    expect(
        find.text('TaskBoard drag-and-drop between columns'), findsNothing);

    // Compose author + keyword: alice-dev AND "OAuth" → both alice OAuth
    // commits remain (demo-user's OAuth-free commits already excluded).
    vm.toggleAuthorFilter('alice-dev');
    await tester.pumpAndSettle();
    expect(find.text('Wire up GitHub OAuth provider in AuthService'),
        findsOneWidget);
    expect(
        find.text('OAuth callback URL fix for Windows + sign-in error states'),
        findsOneWidget);

    // Clearing filters restores the full list.
    vm.clearFilters();
    await tester.pumpAndSettle();
    expect(
        find.text('TaskBoard drag-and-drop between columns'), findsOneWidget);
    expect(find.text('breakdownTask: zod schema + cycle detection draft'),
        findsOneWidget);
  });

  testWidgets('range filter narrows the list to the picked days',
      (tester) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await _openCommitsTab(tester);
    await _switchToListView(tester);
    final vm = tester
        .element(find.text('Commit map'))
        .read<CommitsViewModel>();

    // Filter to yesterday..today: the freshest commit (now − 2h, which may
    // straddle midnight) stays; the oldest (now − 2d5h) always falls outside.
    final now = DateTime.now();
    vm.setRange(now.subtract(const Duration(days: 1)), now);
    await tester.pumpAndSettle();

    expect(
        find.text('TaskBoard drag-and-drop between columns'), findsOneWidget);
    expect(find.text('Add MVVM skeleton and Firebase config placeholders'),
        findsNothing);

    // Clearing goes back to the full recent list.
    vm.clearRange();
    await tester.pumpAndSettle();
    expect(find.text('Add MVVM skeleton and Firebase config placeholders'),
        findsOneWidget);
  });

  testWidgets('branch graph (default view) shows topology, tips and PR badge',
      (tester) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await _openCommitsTab(tester);

    // The fake getCommitGraph topology: merge of feature/daily-report (#7).
    expect(
      find.text('Merge pull request #7 from demo/feature-daily-report'),
      findsOneWidget,
    );
    expect(find.text('#7'), findsOneWidget); // merge node's PR badge
    expect(find.text('main'), findsOneWidget); // branch tip labels
    expect(find.text('feature/daily-report'), findsOneWidget);

    // Tap-to-explain works from the branch view too.
    await tester.tap(find.text('feat(daily): wire report card'));
    await tester.pumpAndSettle();
    expect(find.text('AI work summary'), findsOneWidget);
  });

  testWidgets('the shared AppBar refresh refetches and keeps the branch graph '
      'visible', (tester) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await _openCommitsTab(tester);

    // Branch view is the default — the graph is already on screen.
    expect(
      find.text('Merge pull request #7 from demo/feature-daily-report'),
      findsOneWidget,
    );

    // The per-tab refresh button is gone (D3); refresh is the shared AppBar
    // action (reachable from every tab).
    expect(find.byTooltip('Refresh graph'), findsNothing);
    await tester.tap(find.byTooltip('Refresh current range'));
    await tester.pumpAndSettle();

    // The existing graph stays visible through the (forced) reload.
    expect(
      find.text('Merge pull request #7 from demo/feature-daily-report'),
      findsOneWidget,
    );
  });

  testWidgets('Recent 50 reset chip appears with a range and clears it',
      (tester) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await _openCommitsTab(tester);
    final ctx = tester.element(find.text('Commit map'));
    final vm = ctx.read<CommitsViewModel>();
    final intel = ctx.read<IntelRangeViewModel>();

    // No range → the scope row reads "Recent 50", no reset chip.
    expect(find.byIcon(Icons.restore), findsNothing);

    // The shared range drives the Commits tab; setting it shows the reset chip.
    final now = DateTime.now();
    intel.setRange(DateTimeRange(
      start: now.subtract(const Duration(days: 1)),
      end: now,
    ));
    await tester.pumpAndSettle();
    expect(vm.hasRange, isTrue);

    // Reset affordance is one tap away and goes back to the recent stream. Two
    // restore icons exist now (the AppBar reset action + the scope-row chip);
    // tap the chip in the scope row.
    expect(find.byIcon(Icons.restore), findsWidgets);
    await tester.tap(
        find.widgetWithText(ActionChip, 'Recent 50'),
        warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(vm.hasRange, isFalse);
    expect(intel.hasRange, isFalse);
  });
}
