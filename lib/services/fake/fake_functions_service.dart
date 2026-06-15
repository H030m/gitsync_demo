import '../../config/app_config.dart';
import '../../data/dummy_data.dart';
import '../../models/ask_repo.dart';
import '../../models/commit_graph.dart';
import '../../models/daily_brief.dart';
import '../../models/discord_chat.dart';
import '../../models/sub_task.dart';
import '../../repositories/fake/fake_discord_digest_repo.dart';
import '../functions_service.dart';

/// Canned Cloud Functions responses for fake-backend mode. All methods
/// settle after [AppConfig.simulatedLatency] so loading spinners are visible.
class FakeFunctionsService implements FunctionsService {
  factory FakeFunctionsService() => _instance;
  FakeFunctionsService._internal();
  static final FakeFunctionsService _instance =
      FakeFunctionsService._internal();

  // ---- Repo management ---------------------------------------------------

  @override
  Future<String> addRepo({required String githubUrl}) async {
    await Future.delayed(AppConfig.simulatedLatency * 4);
    // Pretend we registered the repo and got an ID back.
    return DummyData.demoRepoId;
  }

  @override
  Future<void> removeRepo({required String repoId}) async {
    await Future.delayed(AppConfig.simulatedLatency * 2);
  }

  @override
  Future<({int added, int alreadyMembers, List<String> pending})>
      importCollaborators({required String repoId}) async {
    await Future.delayed(AppConfig.simulatedLatency * 3);
    // Pretend two collaborators already had accounts and one hasn't signed in.
    return (added: 2, alreadyMembers: 1, pending: const ['octocat']);
  }

  // ---- AI flows ----------------------------------------------------------

  @override
  Future<List<SubTask>> breakdownTask({
    required String repoId,
    required String goal,
    String? language,
  }) async {
    await Future.delayed(AppConfig.simulatedLatency * 6);
    // Pretend the LLM split the goal into 4 generic subtasks.
    return [
      SubTask(
        id: 'fake-sub-001',
        title: 'Sketch UI for "$goal"',
        description: 'Lay out screens and routes; pick widgets.',
        dependsOn: const [],
        estimatedHours: 2,
      ),
      SubTask(
        id: 'fake-sub-002',
        title: 'Model + Repository for "$goal"',
        description: 'Add Firestore model and CRUD wiring.',
        dependsOn: const ['fake-sub-001'],
        estimatedHours: 3,
      ),
      SubTask(
        id: 'fake-sub-003',
        title: 'ViewModel + state flow',
        description: 'ChangeNotifier with stream subscription.',
        dependsOn: const ['fake-sub-002'],
        estimatedHours: 2,
      ),
      SubTask(
        id: 'fake-sub-004',
        title: 'Wire UI to ViewModel + smoke test',
        description: 'Provider hookup; manual test on Android emulator.',
        dependsOn: const ['fake-sub-001', 'fake-sub-003'],
        estimatedHours: 1.5,
      ),
    ];
  }

  @override
  Future<void> forceUnlockBreakdown({required String repoId}) async {
    await Future.delayed(AppConfig.simulatedLatency);
  }

  @override
  Future<int> deleteAllTasks({required String repoId}) async {
    await Future.delayed(AppConfig.simulatedLatency);
    return 0;
  }

  @override
  Future<({String assigneeId, String reasoning})> assignTask({
    required String repoId,
    required String taskId,
  }) async {
    await Future.delayed(AppConfig.simulatedLatency * 5);
    return (
      assigneeId: DummyData.aliceId,
      reasoning:
          'Alice has the lowest activeIssueCount (3) and her expertiseTags '
          'include "backend" + "firestore", which match this task.',
    );
  }

  @override
  Future<String> generateHandoff({
    required String repoId,
    required String taskId,
    String? language,
    String? runId,
  }) async {
    await Future.delayed(AppConfig.simulatedLatency * 8);
    // W6: surface the requested language so a regenerate is visibly different.
    final langNote = language != null && language.isNotEmpty
        ? '\n\n> _Regenerated in $language (fake demo)._'
        : '';
    return '''
## What was done
- Implemented $taskId end-to-end with tests.
- Wired into the matching ViewModel via Provider.

## Why this way
- Followed the course MVVM layering (View → ViewModel → Repository → Firestore).
- Used `provider` over Riverpod to stay consistent with the rest of the codebase.

## What's left for the next engineer
- Add a confirmation dialog before destructive actions.
- Move colors from hardcoded hex to `Theme.of(ctx).colorScheme.X`.

## Gotchas
- The Firestore listener may emit twice on cold start — guard with `if (mounted)`.
- This is a FAKE handoff generated in debug mode; the real one comes from the
  `generateHandoffFlow` Cloud Function once it is implemented.$langNote
''';
  }

  @override
  Future<String> summarizeDay({
    required String repoId,
    required String startDate,
    String? endDate,
    String? language,
  }) async {
    await Future.delayed(AppConfig.simulatedLatency * 4);
    final base = DummyData.todayReport.summary;
    // W6: a language-tagged regenerate visibly annotates the canned summary.
    return language != null && language.isNotEmpty
        ? '$base\n\n_(Regenerated in $language — fake demo.)_'
        : base;
  }

  @override
  Future<String> explainCommit({
    required String repoId,
    required String sha,
    bool force = false,
    String? language,
    String? runId,
  }) async {
    // *5 so the fake agent-trace (4 canned steps) plays through before we return.
    await Future.delayed(AppConfig.simulatedLatency * 5);
    final commit =
        DummyData.commits.where((c) => c.sha == sha).firstOrNull;
    final message = commit?.message ?? sha.substring(0, 7);
    // W6: a language-tagged recompute visibly annotates the canned explanation.
    final langNote = language != null && language.isNotEmpty
        ? '\n\n_(Recomputed in $language — fake demo.)_'
        : '';
    return '**What was done** — ${commit?.aiSummary ?? message}\n\n'
        '**Why / context** — part of the Sprint 1 push; pairs with the linked '
        'task(s) ${commit?.linkedTaskIds.join(", ") ?? ""}.\n\n'
        '**Where** — ${commit?.filesChanged.join(", ") ?? "(not recorded)"}\n\n'
        '*(這是 fake backend 的示範回覆。)*$langNote';
  }

  @override
  Future<String> summarizeAuthorWork({
    required String repoId,
    String? login,
    List<String> names = const [],
    bool force = false,
  }) async {
    await Future.delayed(AppConfig.simulatedLatency * 3);
    final label = (login != null && login.isNotEmpty)
        ? login
        : (names.isNotEmpty ? names.first : 'unknown');
    return '## $label 的工作統整\n\n'
        '- 主要負責 commit 的提交與整合。\n'
        '- 參與了功能開發與修正。\n'
        '- 協助專案推進。\n\n'
        '*(這是 fake backend 的示範回覆。)*';
  }

  @override
  Future<CommitGraph> getCommitGraph({
    required String repoId,
    String? startDate,
    String? endDate,
    bool force = false,
  }) async {
    await Future.delayed(AppConfig.simulatedLatency * 3);
    // Small fixed topology: feature/daily-report forks off main and merges
    // back via PR #7 — enough to exercise lanes, fork and merge edges.
    final now = DateTime.now();
    GraphCommit c(
      String sha,
      String message,
      List<String> parents,
      int hoursAgo, {
      String branch = 'main',
      bool isMerge = false,
      int? prNumber,
      String login = 'demo-dev',
    }) =>
        GraphCommit(
          sha: sha,
          message: message,
          committedAt: now.subtract(Duration(hours: hoursAgo)),
          parents: parents,
          authorLogin: login,
          authorName: login,
          primaryBranch: branch,
          isMerge: isMerge,
          prNumber: prNumber,
        );
    return CommitGraph(
      commits: [
        c('g6', 'Merge pull request #7 from demo/feature-daily-report',
            ['g3', 'g5'], 1, isMerge: true, prNumber: 7),
        c('g5', 'feat(daily): wire report card', ['g4'], 2,
            branch: 'feature/daily-report', login: 'alice-dev'),
        c('g4', 'feat(daily): scaffold daily view', ['g2'], 5,
            branch: 'feature/daily-report', login: 'alice-dev'),
        c('g3', 'fix(auth): refresh token race', ['g2'], 6),
        c('g2', 'chore: bump deps', ['g1'], 26),
        c('g1', 'feat: initial scaffold', ['g0-offscreen'], 30),
      ],
      branches: const [
        GraphBranch(name: 'main', tipSha: 'g6', isDefault: true),
        GraphBranch(name: 'feature/daily-report', tipSha: 'g5'),
      ],
    );
  }

  @override
  Future<DailyBriefReply> dailyBrief({
    required String repoId,
    required String date,
    String? endDate,
    required String question,
    List<DailyBriefTurn> history = const [],
  }) async {
    await Future.delayed(AppConfig.simulatedLatency * 3);

    // Keyword-match the demo commits the same way the backend tool does, so the
    // fake answer cites real "sources" in the panel.
    final terms = question
        .toLowerCase()
        .split(RegExp(r'[^a-z0-9一-鿿]+'))
        .where((t) => t.length >= 2)
        .toSet();
    final commits = DummyData.commits;
    final matched = commits.where((c) {
      final hay = '${c.message} ${c.aiSummary ?? ''}'.toLowerCase();
      return terms.any(hay.contains);
    }).toList();
    final hits = matched.isNotEmpty ? matched : commits;

    final sources = hits
        .map((c) => DailyBriefSource(
              sha: c.sha,
              message: c.message.split('\n').first,
              authorName: c.author.name,
              authorLogin: c.author.login,
              aiSummary: c.aiSummary,
              linkedTaskIds: c.linkedTaskIds,
            ))
        .toList();

    final answer = matched.isNotEmpty
        ? '根據今天的活動，有 ${matched.length} 個相關的 commit（見下方來源）。'
            '重點：${matched.first.aiSummary ?? matched.first.message}\n\n'
            '*(這是 fake backend 的示範回覆。)*'
        : '今天沒有和你問題直接相關的 commit；以下列出最近的提交作為參考。\n\n'
            '*(這是 fake backend 的示範回覆。)*';

    return DailyBriefReply(answer: answer, sources: sources);
  }

  @override
  Future<AskRepoReply> askRepo({
    required String repoId,
    required String question,
    List<AskRepoTurn> history = const [],
    String? runId,
  }) async {
    // Outlast the FakeAgentRunRepository's 4-step canned trace (one step per
    // simulatedLatency) so the sheet shows the trace appear live BEFORE the
    // answer resolves.
    await Future.delayed(AppConfig.simulatedLatency * 5);

    final terms = question
        .toLowerCase()
        .split(RegExp(r'[^a-z0-9一-鿿]+'))
        .where((t) => t.length >= 2)
        .toSet();

    // Commit sources — keyword-match the demo commits (mirrors the backend).
    final commits = DummyData.commits;
    final matchedCommits = commits.where((c) {
      final hay = '${c.message} ${c.aiSummary ?? ''}'.toLowerCase();
      return terms.any(hay.contains);
    }).toList();
    final commitHits = matchedCommits.isNotEmpty ? matchedCommits : commits;
    // Split into per-author windows so fake mode demonstrates the grouped
    // panels (mirrors the live backend's per-person windows).
    final byAuthor = <String, List<DailyBriefSource>>{};
    for (final c in commitHits) {
      (byAuthor[c.author.name] ??= []).add(DailyBriefSource(
        sha: c.sha,
        message: c.message.split('\n').first,
        authorName: c.author.name,
        authorLogin: c.author.login,
        aiSummary: c.aiSummary,
        linkedTaskIds: c.linkedTaskIds,
        committedAt: c.committedAt.toDate(),
      ));
    }
    final commitGroups = byAuthor.entries
        .map((e) => AskRepoCommitGroup(label: e.key, commits: e.value))
        .toList();

    // Discord sources — keyword-match the demo messages, grouped with one
    // neighbor before/after each match for context (mirrors discordChat fake).
    final all = DummyData.discordMessages;
    final matchIdxs = <int>[];
    for (var i = 0; i < all.length; i++) {
      if (terms.any(all[i].content.toLowerCase().contains)) matchIdxs.add(i);
    }
    DiscordChatSource src(int i, {required bool isMatch}) {
      final m = all[i];
      return DiscordChatSource(
        messageId: m.id,
        channelId: m.channelId,
        authorName: m.authorName,
        content: m.content,
        timestamp: m.timestamp.toDate().toIso8601String(),
        isMatch: isMatch,
      );
    }

    final snippets = <DiscordChatSnippet>[];
    for (final i in matchIdxs.take(2)) {
      final idxs = <int>{
        if (i - 1 >= 0) i - 1,
        i,
        if (i + 1 < all.length) i + 1,
      }.toList()
        ..sort();
      snippets.add(DiscordChatSnippet(
        channelId: all[i].channelId,
        messages: [for (final j in idxs) src(j, isMatch: j == i)],
      ));
    }

    final answer = matchedCommits.isNotEmpty || matchIdxs.isNotEmpty
        ? '根據這個 repo 的活動與討論，我找到 ${matchedCommits.length} 個相關 commit'
            '${matchIdxs.isNotEmpty ? '、以及相關的 Discord 對話' : ''}（見下方來源）。\n\n'
            '*(這是 fake backend 的示範回覆。)*'
        : '我在這個 repo 裡找不到和你問題直接相關的內容；以下列出最近的提交作為參考。\n\n'
            '*(這是 fake backend 的示範回覆。)*';

    return AskRepoReply(
      answer: answer,
      commitGroups: commitGroups,
      snippets: snippets,
    );
  }

  // ---- Discord -----------------------------------------------------------

  @override
  Future<void> setDiscordWebhook({
    required String repoId,
    required String webhookUrl,
    required List<String> channelIds,
  }) async {
    await Future.delayed(AppConfig.simulatedLatency);
  }

  @override
  Future<String> requestDiscordFetch({
    required String repoId,
    required String date,
  }) async {
    // Mimic the real round-trip (bot backfill + digest flow) then emit a
    // digest so the Discord tab's refresh shows a result in fake mode.
    await Future.delayed(AppConfig.simulatedLatency * 4);
    FakeDiscordDigestRepository().emitDemoDigest(repoId, date);
    return 'fake-fetch-req-001';
  }

  @override
  Future<void> setDiscordStartDate({
    required String repoId,
    required String startDate,
  }) async {
    await Future.delayed(AppConfig.simulatedLatency);
  }

  @override
  Future<void> setDiscordRange({
    required String repoId,
    required String startDate,
    required String endDate,
  }) async {
    await Future.delayed(AppConfig.simulatedLatency);
  }

  @override
  Future<String> editDiscordDigest({
    required String repoId,
    required String date,
    required String instruction,
    String? runId,
  }) async {
    await Future.delayed(AppConfig.simulatedLatency * 3);
    final repo = FakeDiscordDigestRepository();
    final newMarkdown =
        '${DummyData.discordDigestMarkdown}\n\n> _AI 已依指令調整：「$instruction」（fake 示範）_';
    repo.applyEdit(repoId, date, markdown: newMarkdown);
    return newMarkdown;
  }

  @override
  Future<void> setDigestLock({
    required String repoId,
    required String date,
    required bool locked,
  }) async {
    await Future.delayed(AppConfig.simulatedLatency);
    FakeDiscordDigestRepository().applyEdit(repoId, date, locked: locked);
  }

  @override
  Future<DiscordChatReply> discordChat({
    required String repoId,
    required String question,
    List<DiscordChatTurn> history = const [],
    String? startDate,
    String? endDate,
    String? runId,
  }) async {
    // *5 so the fake agent-trace (4 canned steps) plays through before we return.
    await Future.delayed(AppConfig.simulatedLatency * 5);

    final all = DummyData.discordMessages;

    // Keyword-match the demo messages the same way the backend tool does, then
    // group each match with one neighbor before/after as context — mirroring
    // the real callable's conversation-cluster shape.
    final terms = question
        .toLowerCase()
        .split(RegExp(r'[^a-z0-9一-鿿]+'))
        .where((t) => t.length >= 2)
        .toSet();
    final matchIdxs = <int>[];
    for (var i = 0; i < all.length; i++) {
      final hay = all[i].content.toLowerCase();
      if (terms.any(hay.contains)) matchIdxs.add(i);
    }

    DiscordChatSource src(int i, {required bool isMatch}) {
      final m = all[i];
      return DiscordChatSource(
        messageId: m.id,
        channelId: m.channelId,
        authorName: m.authorName,
        content: m.content,
        timestamp: m.timestamp.toDate().toIso8601String(),
        isMatch: isMatch,
      );
    }

    final snippets = <DiscordChatSnippet>[];
    final hasMatch = matchIdxs.isNotEmpty;
    if (hasMatch) {
      // Build up to two clusters around the first matches; include one neighbor
      // before/after each match for context.
      for (final i in matchIdxs.take(2)) {
        final idxs = <int>{
          if (i - 1 >= 0) i - 1,
          i,
          if (i + 1 < all.length) i + 1,
        }.toList()
          ..sort();
        snippets.add(DiscordChatSnippet(
          channelId: all[i].channelId,
          messages: [for (final j in idxs) src(j, isMatch: j == i)],
        ));
      }
    } else {
      // Nothing matched: show the last ~3 messages as plain context.
      final start = all.length > 3 ? all.length - 3 : 0;
      snippets.add(DiscordChatSnippet(
        channelId: all.isNotEmpty ? all[start].channelId : '',
        messages: [
          for (var j = start; j < all.length; j++) src(j, isMatch: false),
        ],
      ));
    }

    final answer = !hasMatch
        ? '我在這個 repo 的 Discord 訊息裡找不到相關內容。'
        : '根據團隊的 Discord 聊天，以下幾段對話和你的問題相關。詳見下方可滑動的相關對話。\n\n'
            '*(這是 fake backend 的示範回覆。)*';

    return DiscordChatReply(answer: answer, snippets: snippets);
  }

  // ---- FCM ---------------------------------------------------------------

  @override
  Future<void> subscribeToTopic({
    required String token,
    required String topic,
  }) async {
    await Future.delayed(AppConfig.simulatedLatency);
  }
}
