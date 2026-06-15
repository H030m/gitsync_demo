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

// Renders the real DailyViewPage (Summary tab) against the fake backend and
// drives the global "Ask GitSync" chat — now the shared, repo-wide
// AskRepoViewModel — verifying the intelligence-hub UI wires up end-to-end.
//
// DailyBriefChatViewModel is still provided (the page's range fan-out keeps it
// in sync) even though the Summary chat no longer reads it.
//
// `locale` pins `context.l10n` to a known UI language so finders match the
// strings the test was authored against — defaults to Traditional Chinese
// (the production default since the i18n switch in `5b7e562`) so pre-existing
// tests that look for zh strings keep passing; tests that look for English
// strings pass `AppLocale.en`.
Widget _harness({AppLocale locale = AppLocale.zhHant}) {
  const repoId = DummyData.demoRepoId;
  // [pinLocale] wraps the MaterialApp itself (rather than its `home`) so the
  // `LocaleNotifier` provider sits ABOVE MaterialApp's Navigator — that way
  // routes pushed via `showModalBottomSheet` also resolve `context.l10n` to
  // the pinned locale.
  return pinLocale(
    locale,
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
          ChangeNotifierProvider(create: (_) => AskRepoViewModel(repoId: repoId)),
          ChangeNotifierProvider(create: (_) => IntelRangeViewModel()),
        ],
        child: const DailyViewPage(repoId: repoId),
      ),
    ),
  );
}

void main() {
  testWidgets('Summary tab shows the daily report sections', (tester) async {
    // Tall viewport so every lazily-built section renders without scrolling.
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    // Pin English so finders match the English literals below.
    await tester.pumpWidget(_harness(locale: AppLocale.en));
    await tester.pumpAndSettle();

    // Today's per-day card is expanded by default, showing the full report.
    expect(find.textContaining('Today'), findsWidgets);
    expect(find.textContaining('Sprint 1 skeleton merged'), findsOneWidget);
    expect(find.text('Commit rollup'), findsOneWidget);
    expect(find.text('Contributions'), findsOneWidget);
    // The lower chat is now the global, repo-wide "Ask GitSync" assistant.
    expect(find.text('Ask GitSync'), findsOneWidget);
    expect(
      find.byWidgetPredicate((w) =>
          w is TextField &&
          w.decoration?.hintText == 'Ask GitSync about this repo…'),
      findsOneWidget,
    );
  });

  testWidgets('asking a question adds an AI answer with source commits',
      (tester) async {
    await tester.pumpWidget(_harness());
    await tester.pumpAndSettle();

    final field = find.byWidgetPredicate(
      (w) =>
          w is TextField &&
          w.decoration?.hintText == '問問 GitSync 關於這個 repo…',
    );
    expect(field, findsOneWidget);

    await tester.enterText(field, 'OAuth 進度?');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();

    // The user's question and at least one AI commit-source panel are now on
    // screen. The shared Ask-GitSync rendering now heads each panel with its
    // per-author window label, so assert the panel via its commit icon.
    expect(find.text('OAuth 進度?'), findsOneWidget);
    expect(find.byIcon(Icons.commit_outlined), findsWidgets);
  });

  testWidgets('a multi-day range shows one collapsible card per day',
      (tester) async {
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    // Pin English so finders match the English literals below.
    await tester.pumpWidget(_harness(locale: AppLocale.en));
    await tester.pumpAndSettle();

    // Pick a 3-day range ending today via the shared range notifier.
    final report =
        tester.element(find.byType(DailyViewPage)).read<DailyReportViewModel>();
    final intel =
        tester.element(find.byType(DailyViewPage)).read<IntelRangeViewModel>();
    final now = DateTime.now();
    intel.setRange(DateTimeRange(
      start: now.subtract(const Duration(days: 2)),
      end: now,
    ));
    await tester.pumpAndSettle();

    // The reports panel defaults to collapsed for multi-day ranges (single-day
    // stays expanded), so tap its header to reveal the per-day cards.
    await tester.tap(find.text('Daily report'));
    await tester.pumpAndSettle();

    // The report VM took the range → exactly 3 day cards, rendered inside the
    // upper day-report panel.
    expect(report.rangeDays.length, 3);
    expect(find.byKey(ValueKey(DailyReportViewModel.dayKeyOf(now))),
        findsOneWidget);

    // Today's card is expanded — the full body (Regenerate + sub-cards) shows.
    expect(find.widgetWithText(TextButton, 'Regenerate'), findsOneWidget);
    expect(find.text('Commit rollup'), findsOneWidget);

    // Tap the header to collapse; the full body disappears (the one-line
    // summary preview remains in the collapsed header).
    await tester.tap(find.textContaining('Today ·'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextButton, 'Regenerate'), findsNothing);
    expect(find.text('Commit rollup'), findsNothing);
  });

  testWidgets('the day-report panel collapses to a single header row',
      (tester) async {
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    // Pin English so finders match the English literals below.
    await tester.pumpWidget(_harness(locale: AppLocale.en));
    await tester.pumpAndSettle();

    final intel =
        tester.element(find.byType(DailyViewPage)).read<IntelRangeViewModel>();
    final now = DateTime.now();
    intel.setRange(DateTimeRange(
      start: now.subtract(const Duration(days: 2)),
      end: now,
    ));
    await tester.pumpAndSettle();

    // The reports panel defaults to collapsed for multi-day ranges; the header
    // is always present, so tap it to expand and reveal the day cards.
    expect(find.text('Daily report'), findsOneWidget);
    await tester.tap(find.text('Daily report'));
    await tester.pumpAndSettle();
    expect(find.byKey(ValueKey(DailyReportViewModel.dayKeyOf(now))),
        findsOneWidget);
    // The expanded panel pins a Scrollbar flush to its right edge.
    expect(find.byType(Scrollbar), findsWidgets);

    // Collapsing the whole panel via its header hides every day card.
    await tester.tap(find.text('Daily report'));
    await tester.pumpAndSettle();
    expect(find.byKey(ValueKey(DailyReportViewModel.dayKeyOf(now))),
        findsNothing);
    expect(find.text('Daily report'), findsOneWidget);
  });

  testWidgets('the new-session button clears the chat thread', (tester) async {
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(_harness());
    await tester.pumpAndSettle();

    // Seed a turn by asking a question.
    final field = find.byWidgetPredicate(
      (w) =>
          w is TextField &&
          w.decoration?.hintText == '問問 GitSync 關於這個 repo…',
    );
    await tester.enterText(field, 'OAuth 進度?');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
    expect(find.text('OAuth 進度?'), findsOneWidget);

    // Tap "開啟新 session" → the thread empties immediately.
    await tester.tap(find.byTooltip('開啟新 session'));
    await tester.pumpAndSettle();
    expect(find.text('OAuth 進度?'), findsNothing);
  });

  testWidgets('a day with no report offers a generate button that fires '
      'summarizeDay for that day', (tester) async {
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(_harness());
    await tester.pumpAndSettle();

    final report =
        tester.element(find.byType(DailyViewPage)).read<DailyReportViewModel>();
    final intel =
        tester.element(find.byType(DailyViewPage)).read<IntelRangeViewModel>();
    final now = DateTime.now();
    final yesterday = now.subtract(const Duration(days: 1));
    // Range = yesterday..yesterday: the fake has no report for it.
    intel.setRange(DateTimeRange(start: yesterday, end: yesterday));
    await tester.pumpAndSettle();

    // A non-today card starts collapsed; expand it via its header.
    await tester.tap(find.text(DailyReportViewModel.dayKeyOf(yesterday)));
    await tester.pumpAndSettle();

    // The expanded card has no report → offers "產生日報".
    final generate = find.widgetWithText(FilledButton, '產生日報');
    expect(generate, findsOneWidget);

    // Tapping it drives the VM's per-day generation state.
    expect(report.isGeneratingDay(DailyReportViewModel.dayKeyOf(yesterday)),
        isFalse);
    await tester.tap(generate);
    await tester.pump();
    expect(report.isGeneratingDay(DailyReportViewModel.dayKeyOf(yesterday)),
        isTrue);
    await tester.pumpAndSettle();
    expect(report.isGeneratingDay(DailyReportViewModel.dayKeyOf(yesterday)),
        isFalse);

    // Drain the fake Discord backfill timer (intel.setRange → discord.setRange).
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('the shared range scopes the other tabs AND binds the Discord '
      'backfill range (additive-only callable), reverted from 06-04 — set',
      (tester) async {
    await tester.pumpWidget(_harness());
    await tester.pumpAndSettle();

    final ctx = tester.element(find.byType(DailyViewPage));
    final intel = ctx.read<IntelRangeViewModel>();
    final report = ctx.read<DailyReportViewModel>();
    final commits = ctx.read<CommitsViewModel>();
    final discord = ctx.read<DiscordMessagesViewModel>();

    expect(commits.hasRange, isFalse);
    expect(report.hasRange, isFalse);

    final now = DateTime.now();
    intel.setRange(DateTimeRange(
      start: now.subtract(const Duration(days: 2)),
      end: now,
    ));
    // SEMANTICS REVERTED (06-05, D1): setDiscordRange is now additive-only
    // (deletes nothing), so binding the shared range to Discord is safe again.
    // The shared range now DOES call vm.setRange → settingRange flips true
    // before the fake resolves (the 06-04 test asserted the opposite because
    // the callable used to be destructive). It also mirrors into the display
    // view range immediately.
    await tester.pump();
    expect(discord.settingRange, isTrue);
    expect(discord.viewEnd, isNotNull);
    await tester.pumpAndSettle();
    expect(discord.settingRange, isFalse);

    // Commits + report VMs both took the shared range.
    expect(commits.hasRange, isTrue);
    expect(report.hasRange, isTrue);

    // Clearing resets the other three tabs and clears the Discord view scope.
    intel.clear();
    await tester.pump();
    expect(commits.hasRange, isFalse);
    expect(report.hasRange, isFalse);
    expect(discord.viewEnd, isNull);
    await tester.pumpAndSettle();

    // Drain any fake-backend delayed timers (e.g. the commits-graph reload that
    // clearRange kicks off) so the harness doesn't flag a pending timer.
    await tester.pump(const Duration(seconds: 1));
  });
}
