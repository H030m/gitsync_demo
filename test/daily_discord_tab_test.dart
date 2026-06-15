import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:gitsync/data/dummy_data.dart';
import 'package:gitsync/l10n/app_locale.dart';
import 'package:gitsync/models/commit_graph.dart';
import 'package:gitsync/models/daily_brief.dart';
import 'package:gitsync/models/discord_chat.dart';
import 'package:gitsync/models/discord_digest.dart';
import 'package:gitsync/models/sub_task.dart';
import 'package:gitsync/repositories/fake/fake_discord_digest_repo.dart';
import 'package:gitsync/services/fake/fake_functions_service.dart';
import 'package:gitsync/services/functions_service.dart';
import 'package:gitsync/view_models/ask_repo_vm.dart';
import 'package:gitsync/view_models/commits_vm.dart';
import 'package:gitsync/view_models/daily_brief_vm.dart';
import 'package:gitsync/view_models/daily_report_vm.dart';
import 'package:gitsync/view_models/discord_chat_vm.dart';
import 'package:gitsync/view_models/discord_messages_vm.dart';
import 'package:gitsync/view_models/intel_range_vm.dart';
import 'package:gitsync/views/daily/daily_view_page.dart';

import '_helpers/locale.dart';

const _repoId = DummyData.demoRepoId;

// Spy over the canned fake backend: delegates everything to the singleton fake
// but counts the two calls the shared AppBar Refresh drives — getCommitGraph
// (force) and requestDiscordFetch (one per day in the window).
class _SpyFunctions implements FunctionsService {
  final _fake = FakeFunctionsService();

  int graphCalls = 0;
  bool lastGraphForce = false;
  int fetchCalls = 0;
  final List<String> fetchDates = [];

  @override
  Future<CommitGraph> getCommitGraph({
    required String repoId,
    String? startDate,
    String? endDate,
    bool force = false,
  }) {
    graphCalls++;
    lastGraphForce = force;
    return _fake.getCommitGraph(
      repoId: repoId,
      startDate: startDate,
      endDate: endDate,
      force: force,
    );
  }

  @override
  Future<String> requestDiscordFetch({
    required String repoId,
    required String date,
  }) {
    fetchCalls++;
    fetchDates.add(date);
    return _fake.requestDiscordFetch(repoId: repoId, date: date);
  }

  // Everything else delegates straight through.
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError(invocation.memberName.toString());

  @override
  Future<String> addRepo({required String githubUrl}) =>
      _fake.addRepo(githubUrl: githubUrl);
  @override
  Future<void> removeRepo({required String repoId}) =>
      _fake.removeRepo(repoId: repoId);
  @override
  Future<List<SubTask>> breakdownTask(
          {required String repoId, required String goal}) =>
      _fake.breakdownTask(repoId: repoId, goal: goal);
  @override
  Future<void> forceUnlockBreakdown({required String repoId}) =>
      _fake.forceUnlockBreakdown(repoId: repoId);
  @override
  Future<({String assigneeId, String reasoning})> assignTask(
          {required String repoId, required String taskId}) =>
      _fake.assignTask(repoId: repoId, taskId: taskId);
  @override
  Future<String> generateHandoff(
          {required String repoId,
          required String taskId,
          String? language,
          String? runId}) =>
      _fake.generateHandoff(
          repoId: repoId, taskId: taskId, language: language, runId: runId);
  @override
  Future<String> summarizeDay(
          {required String repoId,
          required String startDate,
          String? endDate,
          String? language}) =>
      _fake.summarizeDay(
          repoId: repoId,
          startDate: startDate,
          endDate: endDate,
          language: language);
  @override
  Future<DailyBriefReply> dailyBrief(
          {required String repoId,
          required String date,
          String? endDate,
          required String question,
          List<DailyBriefTurn> history = const []}) =>
      _fake.dailyBrief(
          repoId: repoId,
          date: date,
          endDate: endDate,
          question: question,
          history: history);
  @override
  Future<String> explainCommit(
          {required String repoId,
          required String sha,
          bool force = false,
          String? language,
          String? runId}) =>
      _fake.explainCommit(
          repoId: repoId, sha: sha, force: force, language: language, runId: runId);
  @override
  Future<void> setDiscordWebhook(
          {required String repoId,
          required String webhookUrl,
          required List<String> channelIds}) =>
      _fake.setDiscordWebhook(
          repoId: repoId, webhookUrl: webhookUrl, channelIds: channelIds);
  @override
  Future<void> setDiscordStartDate(
          {required String repoId, required String startDate}) =>
      _fake.setDiscordStartDate(repoId: repoId, startDate: startDate);
  @override
  Future<void> setDiscordRange(
          {required String repoId,
          required String startDate,
          required String endDate}) =>
      _fake.setDiscordRange(
          repoId: repoId, startDate: startDate, endDate: endDate);
  @override
  Future<String> editDiscordDigest(
          {required String repoId,
          required String date,
          required String instruction,
          String? runId}) =>
      _fake.editDiscordDigest(
          repoId: repoId, date: date, instruction: instruction, runId: runId);
  @override
  Future<void> setDigestLock(
          {required String repoId,
          required String date,
          required bool locked}) =>
      _fake.setDigestLock(repoId: repoId, date: date, locked: locked);
  @override
  Future<DiscordChatReply> discordChat(
          {required String repoId,
          required String question,
          List<DiscordChatTurn> history = const [],
          String? startDate,
          String? endDate,
          String? runId}) =>
      _fake.discordChat(
          repoId: repoId,
          question: question,
          history: history,
          startDate: startDate,
          endDate: endDate,
          runId: runId);
  @override
  Future<void> subscribeToTopic(
          {required String token, required String topic}) =>
      _fake.subscribeToTopic(token: token, topic: topic);
}

// `locale` pins `context.l10n` to a known UI language so finders match the
// strings the test was authored against — defaults to Traditional Chinese
// (the production default since the i18n switch in `5b7e562`) so pre-existing
// tests that look for zh strings (e.g. `'重新整理目前範圍'`) keep passing; tests
// that look for English strings pass `AppLocale.en`.
Widget _harness({FunctionsService? functions, AppLocale locale = AppLocale.zhHant}) {
  // [pinLocale] wraps the MaterialApp itself (rather than its `home`) so the
  // `LocaleNotifier` provider sits ABOVE MaterialApp's Navigator — that way
  // routes pushed via `showModalBottomSheet` also resolve `context.l10n` to
  // the pinned locale.
  return pinLocale(
    locale,
    child: MaterialApp(
      home: MultiProvider(
        providers: [
          ChangeNotifierProvider(
              create: (_) =>
                  CommitsViewModel(repoId: _repoId, functionsService: functions)),
          ChangeNotifierProvider(
              create: (_) => DiscordMessagesViewModel(
                  repoId: _repoId, functionsService: functions)),
          ChangeNotifierProvider(
              create: (_) => DiscordChatViewModel(
                  repoId: _repoId, functionsService: functions)),
          ChangeNotifierProvider(
              create: (_) => DailyReportViewModel(repoId: _repoId)),
          ChangeNotifierProvider(
              create: (_) => DailyBriefChatViewModel(repoId: _repoId)),
          // The Summary tab's chat now reads the shared, repo-wide AskRepoViewModel.
          ChangeNotifierProvider(create: (_) => AskRepoViewModel(repoId: _repoId)),
          ChangeNotifierProvider(create: (_) => IntelRangeViewModel()),
        ],
        child: const DailyViewPage(repoId: _repoId),
      ),
    ),
  );
}

void main() {
  setUp(() => FakeDiscordDigestRepository().reset());
  tearDown(() => FakeDiscordDigestRepository().reset());

  Future<void> tall(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  void seed(String date) {
    FakeDiscordDigestRepository().seedDigest(
      _repoId,
      DiscordDigest(
        date: date,
        markdown: '**Digest for $date**',
        messageCount: 3,
      ),
    );
  }

  testWidgets('the AppBar Refresh forces a graph reload AND a per-day Discord '
      'fetch for the window', (tester) async {
    await tall(tester);
    final spy = _SpyFunctions();
    await tester.pumpWidget(_harness(functions: spy));
    await tester.pumpAndSettle();

    // Scope a 3-day window so the Discord sweep is observable (3 fetch calls).
    final ctx = tester.element(find.byType(DailyViewPage));
    final now = DateTime.now();
    ctx.read<IntelRangeViewModel>().setRange(DateTimeRange(
          start: now.subtract(const Duration(days: 2)),
          end: now,
        ));
    await tester.pumpAndSettle();

    final graphBefore = spy.graphCalls;
    spy.fetchDates.clear();

    // Tap the shared Refresh in the AppBar.
    await tester.tap(find.byTooltip('重新整理目前範圍'));
    await tester.pumpAndSettle();

    // Commits: one more getCommitGraph, forced.
    expect(spy.graphCalls, greaterThan(graphBefore));
    expect(spy.lastGraphForce, isTrue);
    // Discord: one fetch per day in the 3-day window.
    expect(spy.fetchDates.length, 3);
  });

  testWidgets('the Discord tab has NO local refresh / backfill / date buttons',
      (tester) async {
    await tall(tester);
    await tester.pumpWidget(_harness());
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discord'));
    await tester.pumpAndSettle();

    expect(find.widgetWithText(OutlinedButton, '設定回補範圍'), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Refresh'), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Fetching…'), findsNothing);
  });

  testWidgets('the Commits tab has no local refresh button (shared only)',
      (tester) async {
    await tall(tester);
    // Pin English so the `Commits` tab label and `Refresh current range`
    // tooltip below match the production strings.
    await tester.pumpWidget(_harness(locale: AppLocale.en));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Commits'));
    await tester.pumpAndSettle();

    // The only refresh tooltip on screen is the shared AppBar one.
    expect(find.byTooltip('Refresh graph'), findsNothing);
    expect(find.byTooltip('Refresh current range'), findsOneWidget);
  });

  testWidgets('the Discord digest panel collapses, hiding the day cards',
      (tester) async {
    await tall(tester);
    // Pin English so the `Discord digest` header + `Discord digest · <date>`
    // card labels below match the production strings.
    await tester.pumpWidget(_harness(locale: AppLocale.en));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discord'));
    await tester.pumpAndSettle();

    final ctx = tester.element(find.byType(DailyViewPage));
    final vm = ctx.read<DiscordMessagesViewModel>();
    // Seed two days and scope the window over them.
    seed('2026-06-03');
    seed('2026-06-04');
    vm.setViewRange(DateTime(2026, 6, 3), DateTime(2026, 6, 5));
    await tester.pumpAndSettle();

    // Expanded: the panel header + the day cards are visible.
    expect(find.text('Discord digest'), findsOneWidget); // panel header
    expect(find.text('Discord digest · 2026-06-04'), findsOneWidget);
    // The expanded digest panel pins a Scrollbar flush to its right edge.
    expect(find.byType(Scrollbar), findsWidgets);

    // Collapse the panel via its header → day cards disappear, header stays.
    await tester.tap(find.text('Discord digest'));
    await tester.pumpAndSettle();
    expect(find.text('Discord digest'), findsOneWidget);
    expect(find.text('Discord digest · 2026-06-04'), findsNothing);
    expect(find.text('Discord digest · 2026-06-03'), findsNothing);
  });

  testWidgets('the Discord digest panel bounds its height to ≤45% of viewport',
      (tester) async {
    await tall(tester);
    await tester.pumpWidget(_harness());
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discord'));
    await tester.pumpAndSettle();

    final ctx = tester.element(find.byType(DailyViewPage));
    final vm = ctx.read<DiscordMessagesViewModel>();
    for (final d in ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04']) {
      seed(d);
    }
    vm.setViewRange(DateTime(2026, 6, 1), DateTime(2026, 6, 5));
    await tester.pumpAndSettle();

    // The ConstrainedBox wrapping the scrollable cards caps at 45% height.
    final screenH = tester.view.physicalSize.height / tester.view.devicePixelRatio;
    final box = tester.widgetList<ConstrainedBox>(find.byType(ConstrainedBox))
        .firstWhere((c) => c.constraints.maxHeight == screenH * 0.45);
    expect(box.constraints.maxHeight, screenH * 0.45);
  });

  testWidgets('the Discord chat new-session button clears the thread',
      (tester) async {
    await tall(tester);
    // Pin English so the `Ask AI about the Discord chat…` hint and the
    // `New session` tooltip below match the production strings.
    await tester.pumpWidget(_harness(locale: AppLocale.en));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discord'));
    await tester.pumpAndSettle();

    final field = find.byWidgetPredicate((w) =>
        w is TextField &&
        w.decoration?.hintText == 'Ask AI about the Discord chat…');
    expect(field, findsOneWidget);

    await tester.enterText(field, 'OAuth 進度?');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
    expect(find.text('OAuth 進度?'), findsOneWidget);

    await tester.tap(find.byTooltip('New session'));
    await tester.pumpAndSettle();
    expect(find.text('OAuth 進度?'), findsNothing);
  });
}
