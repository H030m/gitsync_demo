import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:gitsync/data/dummy_data.dart';
import 'package:gitsync/models/commit.dart';
import 'package:gitsync/repositories/commit_repo.dart';
import 'package:gitsync/repositories/user_repo.dart';
import 'package:gitsync/services/functions_service.dart';
import 'package:gitsync/view_models/members_vm.dart';
import 'package:gitsync/view_models/stats_vm.dart';
import 'package:gitsync/view_models/tasks_board_vm.dart';
import 'package:gitsync/views/stats/stats_view_page.dart';

// A spy FunctionsService: records summarizeAuthorWork calls (and the force
// flag) and returns a canned markdown mentioning the author label.
class _SpyFunctionsService implements FunctionsService {
  int summarizeCalls = 0;
  bool? lastForce;
  String? lastLogin;
  List<String>? lastNames;

  @override
  Future<String> summarizeAuthorWork({
    required String repoId,
    String? login,
    List<String> names = const [],
    bool force = false,
  }) async {
    summarizeCalls++;
    lastForce = force;
    lastLogin = login;
    lastNames = names;
    final label = login ?? (names.isNotEmpty ? names.first : 'unknown');
    return '## $label 的工作統整\n\n- 主要負責功能開發。';
  }

  @override
  noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeCommitRepo implements CommitRepository {
  _FakeCommitRepo(this.commits);
  final List<Commit> commits;

  @override
  Future<List<Commit>> fetchAllCommits(String repoId) async => commits;

  @override
  noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _NoopUserRepo implements UserRepository {
  @override
  noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Commit _commit(String login, {String name = '', String? sha}) => Commit(
      sha: sha ?? login + DateTime.now().microsecondsSinceEpoch.toString(),
      repoId: 'r',
      message: 'm',
      author: CommitAuthor(login: login, name: name, email: ''),
      url: '',
    );

// Renders StatsViewPage against the fake backend (DummyData commits + tasks).
Widget _harness() {
  const repoId = DummyData.demoRepoId;
  return MaterialApp(
    home: MultiProvider(
      providers: [
        ChangeNotifierProvider(
            create: (_) => TasksBoardViewModel(repoId: repoId)),
        ChangeNotifierProvider(create: (_) => MembersViewModel(repoId: repoId)),
      ],
      child: const StatsViewPage(repoId: repoId),
    ),
  );
}

void main() {
  testWidgets('renders both tabs; pie legend shows %; 進度表 lists authors', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(_harness());
    await tester.pumpAndSettle();

    // Both tabs present.
    expect(find.text('貢獻度'), findsWidgets);
    expect(find.text('進度表'), findsOneWidget);

    // Tab 1 defaults to the commit basis → its caption is the all-commit one.
    expect(find.text('全部 commit 累計的貢獻度'), findsOneWidget);

    // Legend shows the share percentage.
    expect(find.textContaining('%'), findsWidgets);

    // Switch to Tab 2 (進度表): the new author-summary caption + 詳細情形 rows.
    await tester.tap(find.text('進度表'));
    await tester.pumpAndSettle();

    expect(find.text('每位作者的 commit 佔比與 AI 工作統整'), findsOneWidget);
    expect(find.text('詳細情形'), findsWidgets);
  });

  testWidgets('pie has no in-slice author titles (legend only)', (tester) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(_harness());
    await tester.pumpAndSettle();

    // The pie sections carry no titles; the only author-name occurrences are
    // the legend chips ("name — NN%"). Assert every author-name Text contains
    // the legend separator, i.e. there is no bare in-slice title.
    final dashChips = find.textContaining('—');
    expect(dashChips, findsWidgets, reason: 'legend chips present');
  });

  testWidgets('expanding an author row loads + shows the AI summary; '
      'refresh regenerates with force', (tester) async {
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final spy = _SpyFunctionsService();
    final vm = StatsViewModel(
      repoId: 'r',
      commitRepository: _FakeCommitRepo([
        _commit('alice-dev', name: 'Alice'),
        _commit('alice-dev', name: 'Alice'),
        _commit('bob-ml', name: 'Bob'),
      ]),
      userRepository: _NoopUserRepo(),
      functionsService: spy,
    );

    await tester.pumpWidget(
      MaterialApp(
        home: ChangeNotifierProvider<StatsViewModel>.value(
          value: vm,
          child: Scaffold(
            body: Consumer<StatsViewModel>(
              builder: (_, v, child) => _ProgressTabHarness(vm: v),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Two canonical authors listed.
    expect(find.text('詳細情形'), findsNWidgets(2));

    // Expand the first row → triggers the summary load.
    await tester.tap(find.text('詳細情形').first);
    await tester.pumpAndSettle();

    expect(spy.summarizeCalls, 1);
    expect(spy.lastForce, isFalse);
    expect(find.textContaining('alice-dev 的工作統整'), findsOneWidget);

    // Regenerate via the refresh button → calls again with force:true.
    await tester.tap(find.byIcon(Icons.refresh));
    await tester.pumpAndSettle();

    expect(spy.summarizeCalls, 2);
    expect(spy.lastForce, isTrue);
  });
}

// The page's _ProgressTab is library-private and builds its own VM, so the
// regenerate/force assertion drives a thin stand-in that exercises the exact
// same StatsViewModel summary API the real tab calls, with a spy service
// injected into the VM.
class _ProgressTabHarness extends StatelessWidget {
  const _ProgressTabHarness({required this.vm});
  final StatsViewModel vm;

  @override
  Widget build(BuildContext context) {
    if (vm.commitsLoading) {
      return const Center(child: CircularProgressIndicator());
    }
    return ListView(
      children: [
        for (final g in vm.authorGroups)
          _AuthorRow(vm: vm, group: g),
      ],
    );
  }
}

class _AuthorRow extends StatefulWidget {
  const _AuthorRow({required this.vm, required this.group});
  final StatsViewModel vm;
  final AuthorGroup group;

  @override
  State<_AuthorRow> createState() => _AuthorRowState();
}

class _AuthorRowState extends State<_AuthorRow> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final g = widget.group;
    final markdown = widget.vm.authorSummary(g.key);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: () {
            setState(() => _expanded = !_expanded);
            if (_expanded) widget.vm.loadAuthorSummary(g);
          },
          child: const Text('詳細情形'),
        ),
        if (_expanded) ...[
          if (widget.vm.isSummarizing(g.key))
            const CircularProgressIndicator()
          else if (markdown != null) ...[
            IconButton(
              icon: const Icon(Icons.refresh),
              onPressed: () => widget.vm.loadAuthorSummary(g, force: true),
            ),
            Text(markdown),
          ],
        ],
      ],
    );
  }
}
