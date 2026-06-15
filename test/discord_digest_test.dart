import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:gitsync/data/dummy_data.dart';
import 'package:gitsync/l10n/app_locale.dart';
import 'package:gitsync/models/discord_digest.dart';
import 'package:gitsync/repositories/fake/fake_discord_digest_repo.dart';
import 'package:gitsync/view_models/ask_repo_vm.dart';
import 'package:gitsync/view_models/commits_vm.dart';
import 'package:gitsync/view_models/daily_brief_vm.dart';
import 'package:gitsync/view_models/daily_report_vm.dart';
import 'package:gitsync/view_models/discord_chat_vm.dart';
import 'package:gitsync/view_models/discord_messages_vm.dart';
import 'package:gitsync/view_models/intel_range_vm.dart';
import 'package:gitsync/views/daily/daily_view_page.dart';

import '_helpers/locale.dart';

// Drives the real DailyViewPage's Discord tab against the fake backend, proving
// the digest section renders one card PER DAY in the visible window (the
// 06-05 regression: a window ending on a digest-less day must still surface the
// earlier days' digests).
//
// The widget tests in this file look for English UI strings (e.g.
// `Discord digest · 2026-06-04`, `Lock digest`). Since the upstream i18n
// switch (`5b7e562`) made the default UI language Traditional Chinese,
// `_harness()` pins the locale to English via [pinLocale] so finders match
// the strings the tests were authored against.

const _repoId = DummyData.demoRepoId;

Widget _harness() {
  // [pinLocale] wraps the MaterialApp itself (rather than its `home`) so the
  // `LocaleNotifier` provider sits ABOVE MaterialApp's Navigator — that way
  // routes pushed via `showModalBottomSheet` also resolve `context.l10n` to
  // the pinned English locale.
  return pinLocale(
    AppLocale.en,
    child: MaterialApp(
      home: MultiProvider(
        providers: [
          ChangeNotifierProvider(create: (_) => CommitsViewModel(repoId: _repoId)),
          ChangeNotifierProvider(
              create: (_) => DiscordMessagesViewModel(repoId: _repoId)),
          ChangeNotifierProvider(
              create: (_) => DiscordChatViewModel(repoId: _repoId)),
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

// Seeds an explicit digest doc for [date] (YYYY-MM-DD) in the fake repo.
DiscordDigest _seed(String date, {bool locked = false}) {
  final digest = DiscordDigest(
    date: date,
    markdown: '**Digest for $date**',
    messageCount: 3,
    locked: locked,
  );
  FakeDiscordDigestRepository().seedDigest(_repoId, digest);
  return digest;
}

void main() {
  // The fake digest repo is a process-wide singleton; start each test clean.
  setUp(() => FakeDiscordDigestRepository().reset());
  tearDown(() => FakeDiscordDigestRepository().reset());

  Future<DiscordMessagesViewModel> openDiscordTab(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(_harness());
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discord'));
    await tester.pumpAndSettle();
    return tester
        .element(find.byType(DailyViewPage))
        .read<DiscordMessagesViewModel>();
  }

  testWidgets('two days with digests render two cards, newest first',
      (tester) async {
    _seed('2026-06-03');
    _seed('2026-06-04');

    final vm = await openDiscordTab(tester);
    // Window covering both days (and today 6/5, which has no digest).
    vm.setViewRange(DateTime(2026, 6, 3), DateTime(2026, 6, 5));
    await tester.pumpAndSettle();

    // Exactly the two days that HAVE a digest get a card; the digest-less 6/5
    // is skipped.
    expect(find.text('Discord digest · 2026-06-04'), findsOneWidget);
    expect(find.text('Discord digest · 2026-06-03'), findsOneWidget);
    expect(find.text('Discord digest · 2026-06-05'), findsNothing);

    // Newest first.
    expect(vm.digests.map((d) => d.date).toList(),
        ['2026-06-04', '2026-06-03']);
  });

  testWidgets('a window ending on a digest-less day still shows earlier cards',
      (tester) async {
    // The motivating regression: only older days have digests; the window ends
    // on today (no digest). The section must NOT blank.
    _seed('2026-06-03');
    _seed('2026-06-04');

    final vm = await openDiscordTab(tester);
    vm.setViewRange(DateTime(2026, 6, 3), DateTime(2026, 6, 5));
    await tester.pumpAndSettle();

    expect(find.byType(DailyViewPage), findsOneWidget);
    expect(vm.digests.length, 2);
    expect(find.text('Discord digest · 2026-06-04'), findsOneWidget);
    expect(find.text('Discord digest · 2026-06-03'), findsOneWidget);
  });

  testWidgets('lock toggle acts on the tapped card\'s date', (tester) async {
    _seed('2026-06-03');
    _seed('2026-06-04');

    final vm = await openDiscordTab(tester);
    vm.setViewRange(DateTime(2026, 6, 3), DateTime(2026, 6, 5));
    await tester.pumpAndSettle();

    // Both start unlocked.
    DiscordDigest byDate(String d) =>
        vm.digests.firstWhere((x) => x.date == d);
    expect(byDate('2026-06-03').locked, isFalse);
    expect(byDate('2026-06-04').locked, isFalse);

    // The older card (6/3) starts collapsed; expand it so its lock button is
    // reachable, then tap the lock toggle on THAT card.
    await tester.tap(find.text('Discord digest · 2026-06-03'));
    await tester.pumpAndSettle();

    // Find the lock IconButton inside the 6/3 card subtree.
    final card3 = find.ancestor(
      of: find.text('Discord digest · 2026-06-03'),
      matching: find.byType(AnimatedContainer),
    );
    final lockBtn = find.descendant(
      of: card3,
      matching: find.byTooltip('Lock digest'),
    );
    expect(lockBtn, findsOneWidget);
    await tester.tap(lockBtn);
    await tester.pumpAndSettle();

    // ONLY 6/3 became locked — the dispatch carried the tapped card's date.
    expect(byDate('2026-06-03').locked, isTrue);
    expect(byDate('2026-06-04').locked, isFalse);
  });
}
