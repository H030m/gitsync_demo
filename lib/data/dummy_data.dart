// In-memory seed data for fake backend mode. Everything here is deliberately
// hard-coded so the UI has something to render the moment `flutter run` boots
// — no network, no Firebase, no auth.
//
// Mutations made at runtime live in the FakeXxxRepository in-memory state
// and reset on app restart (this is dummy data, not persistence).
import 'package:cloud_firestore/cloud_firestore.dart';

import '../models/app_user.dart';
import '../models/commit.dart';
import '../models/daily_report.dart';
import '../models/discord_message.dart';
import '../models/member.dart';
import '../models/pull_request.dart';
import '../models/repo.dart';
import '../models/task.dart';

class DummyData {
  DummyData._();

  // ---- IDs --------------------------------------------------------------

  static const demoUserId = 'demo-user-001';
  static const aliceId = 'alice-user-002';
  static const bobId = 'bob-user-003';
  static const demoRepoId = 'team17_gitsync';

  // ---- Helpers ----------------------------------------------------------

  static Timestamp _daysAgo(int days, {int hours = 0, int minutes = 0}) {
    final t = DateTime.now().subtract(
      Duration(days: days, hours: hours, minutes: minutes),
    );
    return Timestamp.fromDate(t);
  }

  // ---- Users ------------------------------------------------------------

  static final AppUser demoUser = AppUser(
    id: demoUserId,
    name: 'Demo User (you)',
    email: 'demo@gitsync.local',
    avatarUrl: '',
    githubLogin: 'demo-user',
    discordUserId: '100000000000000001',
    expertiseTags: const ['flutter', 'frontend'],
  );

  static final AppUser alice = AppUser(
    id: aliceId,
    name: 'Alice Chen',
    email: 'alice@gitsync.local',
    avatarUrl: '',
    githubLogin: 'alice-dev',
    discordUserId: '100000000000000002',
    expertiseTags: const ['backend', 'firestore'],
  );

  static final AppUser bob = AppUser(
    id: bobId,
    name: 'Bob Wang',
    email: 'bob@gitsync.local',
    avatarUrl: '',
    githubLogin: 'bob-ml',
    discordUserId: '100000000000000003',
    expertiseTags: const ['ml', 'openai'],
  );

  static List<AppUser> get users => [demoUser, alice, bob];

  // ---- Repo + Members ---------------------------------------------------

  static final Repo demoRepo = Repo(
    id: demoRepoId,
    name: 'team17/gitsync',
    url: 'https://github.com/team17/gitsync',
    githubRepoId: 999999,
    defaultBranch: 'main',
    createdBy: demoUserId,
    memberIds: const [demoUserId, aliceId, bobId],
    discordChannelIds: const ['111222333444555666'],
    isBreakingDown: false,
  );

  static final List<Member> members = [
    const Member(
      userId: demoUserId,
      role: MemberRole.owner,
      activeIssueCount: 2,
      completedTaskCount: 5,
    ),
    const Member(
      userId: aliceId,
      role: MemberRole.admin,
      activeIssueCount: 3,
      completedTaskCount: 4,
    ),
    const Member(
      userId: bobId,
      role: MemberRole.member,
      activeIssueCount: 1,
      completedTaskCount: 2,
    ),
  ];

  // ---- Tasks ------------------------------------------------------------

  static List<Task> get tasks => [
        Task(
          id: 'task-001',
          title: 'Set up Flutter project skeleton',
          description: 'Add MVVM layers, theme, routing, and Firebase init.',
          status: TaskStatus.done,
          assigneeId: demoUserId,
          source: TaskSource.manual,
          createdBy: demoUserId,
        ),
        Task(
          id: 'task-002',
          title: 'Implement GitHub OAuth sign-in',
          description: 'Wire up Firebase Auth GitHub provider; persist access token.',
          status: TaskStatus.inProgress,
          assigneeId: aliceId,
          dependsOn: const ['task-001'],
          source: TaskSource.manual,
          createdBy: demoUserId,
        ),
        Task(
          id: 'task-003',
          title: 'Build breakdownTask Cloud Function',
          description: 'OpenAI structured output + cycle detection + Firestore batch write.',
          status: TaskStatus.todo,
          assigneeId: bobId,
          dependsOn: const ['task-001'],
          acceptanceCriteria: const [
            'Returns subtasks array with at most 8 items',
            'No circular dependencies',
            'Locks repos/{repoId}.isBreakingDown during run',
          ],
          source: TaskSource.aiBreakdown,
          parentTaskId: null,
          createdBy: demoUserId,
        ),
        Task(
          id: 'task-004',
          title: 'Render tasks board with drag-and-drop',
          description: 'Three-column kanban; drag a card to change status.',
          status: TaskStatus.todo,
          assigneeId: demoUserId,
          dependsOn: const ['task-001'],
          source: TaskSource.manual,
          createdBy: demoUserId,
        ),
        Task(
          id: 'task-005',
          title: 'GitHub webhook handler',
          description: 'Verify HMAC, write raw commit/PR docs to Firestore.',
          status: TaskStatus.todo,
          dependsOn: const ['task-002'],
          source: TaskSource.manual,
          createdBy: demoUserId,
        ),
        Task(
          id: 'task-006',
          title: 'onCommitCreated trigger',
          description: 'Filter, embed, link to task — see ARCHITECTURE §5.6.',
          status: TaskStatus.todo,
          dependsOn: const ['task-005'],
          source: TaskSource.manual,
          createdBy: demoUserId,
        ),
        Task(
          id: 'task-007',
          title: 'Daily report fan-out scheduler',
          description: 'Cloud Tasks queue + dailyReportWorker.',
          status: TaskStatus.todo,
          dependsOn: const ['task-003', 'task-006'],
          source: TaskSource.manual,
          createdBy: demoUserId,
        ),
        Task(
          id: 'task-008',
          title: 'Discord forwarder bot',
          description: 'Standalone discord.js bot; POSTs to discordMessageIngest.',
          status: TaskStatus.todo,
          assigneeId: aliceId,
          source: TaskSource.manual,
          createdBy: demoUserId,
        ),
      ];

  // ---- Commits ----------------------------------------------------------

  static List<Commit> get commits => [
        Commit(
          sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          repoId: demoRepoId,
          message: 'Add MVVM skeleton and Firebase config placeholders',
          author: const CommitAuthor(
            login: 'demo-user',
            name: 'Demo User',
            email: 'demo@gitsync.local',
          ),
          url: 'https://github.com/team17/gitsync/commit/a1b2c3d',
          filesChanged: const ['lib/main.dart', 'pubspec.yaml'],
          additions: 320,
          deletions: 12,
          linkedTaskIds: const ['task-001'],
          aiSummary: 'Initial Flutter MVVM scaffolding committed.',
          committedAt: _daysAgo(2, hours: 5),
        ),
        Commit(
          sha: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
          repoId: demoRepoId,
          message: 'Wire up GitHub OAuth provider in AuthService',
          author: const CommitAuthor(
            login: 'alice-dev',
            name: 'Alice Chen',
            email: 'alice@gitsync.local',
          ),
          url: 'https://github.com/team17/gitsync/commit/b2c3d4e',
          filesChanged: const ['lib/services/authentication.dart'],
          additions: 45,
          deletions: 3,
          linkedTaskIds: const ['task-002'],
          aiSummary: 'GitHub OAuth flow added; access token persisted.',
          committedAt: _daysAgo(1, hours: 8),
        ),
        Commit(
          sha: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
          repoId: demoRepoId,
          message: 'breakdownTask: zod schema + cycle detection draft',
          author: const CommitAuthor(
            login: 'bob-ml',
            name: 'Bob Wang',
            email: 'bob@gitsync.local',
          ),
          url: 'https://github.com/team17/gitsync/commit/c3d4e5f',
          filesChanged: const [
            'functions/src/flows/breakdownTask.ts',
            'functions/src/types.ts',
          ],
          additions: 120,
          deletions: 5,
          linkedTaskIds: const ['task-003'],
          aiSummary: 'Initial OpenAI flow scaffold without the live call.',
          committedAt: _daysAgo(1, hours: 3),
        ),
        Commit(
          sha: 'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5',
          repoId: demoRepoId,
          message: 'OAuth callback URL fix for Windows + sign-in error states',
          author: const CommitAuthor(
            login: 'alice-dev',
            name: 'Alice Chen',
            email: 'alice@gitsync.local',
          ),
          url: 'https://github.com/team17/gitsync/commit/d4e5f6a',
          filesChanged: const [
            'lib/services/authentication.dart',
            'lib/views/sign_in/sign_in_page.dart',
          ],
          additions: 38,
          deletions: 9,
          linkedTaskIds: const ['task-002'],
          aiSummary: 'Fixed the Windows OAuth callback and surfaced errors.',
          committedAt: _daysAgo(0, hours: 7),
        ),
        Commit(
          sha: 'e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
          repoId: demoRepoId,
          message: 'TaskBoard drag-and-drop between columns',
          author: const CommitAuthor(
            login: 'demo-user',
            name: 'Demo User',
            email: 'demo@gitsync.local',
          ),
          url: 'https://github.com/team17/gitsync/commit/e5f6a1b',
          filesChanged: const ['lib/views/tasks/tasks_board_page.dart'],
          additions: 86,
          deletions: 14,
          linkedTaskIds: const ['task-001'],
          aiSummary: 'Kanban columns now support drag-and-drop.',
          committedAt: _daysAgo(0, hours: 2),
        ),
      ];

  // ---- Pull Requests ----------------------------------------------------

  static List<PullRequest> get pullRequests => [
        PullRequest(
          number: 1,
          repoId: demoRepoId,
          title: 'Sprint 1 skeleton',
          state: PrState.merged,
          author: 'demo-user',
          headBranch: 'sprint1/skeleton',
          baseBranch: 'main',
          url: 'https://github.com/team17/gitsync/pull/1',
          linkedTaskIds: const ['task-001'],
          commitShas: const [
            'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          ],
          diffStat: const DiffStat(
            additions: 320,
            deletions: 12,
            changedFiles: 18,
          ),
          mergedAt: _daysAgo(0, hours: 6),
        ),
      ];

  // ---- Discord Messages -------------------------------------------------

  static List<DiscordMessage> get discordMessages => [
        DiscordMessage(
          id: 'msg-001',
          repoId: demoRepoId,
          channelId: '111222333444555666',
          authorId: alice.discordUserId!,
          authorName: alice.name,
          content:
              "Heads up — I'll start the GitHub OAuth piece tonight. Anyone tested the callback URL on Windows yet?",
          mentionedUserIds: const [],
          linkedTaskIds: const ['task-002'],
        ),
        DiscordMessage(
          id: 'msg-002',
          repoId: demoRepoId,
          channelId: '111222333444555666',
          authorId: bob.discordUserId!,
          authorName: bob.name,
          content:
              'For breakdownTask, are we okay treating estimatedHours as floats? Some subtasks might be 0.5h.',
          mentionedUserIds: const [],
          linkedTaskIds: const ['task-003'],
        ),
        DiscordMessage(
          id: 'msg-003',
          repoId: demoRepoId,
          channelId: '111222333444555666',
          authorId: demoUser.discordUserId!,
          authorName: demoUser.name,
          content: 'Floats are fine. zod schema already allows z.number().',
          mentionedUserIds: const [bobId],
          linkedTaskIds: const ['task-003'],
        ),
      ];

  // ---- Discord Digest ---------------------------------------------------

  static const discordDigestMarkdown = '''
**Discord digest**

- Alice is picking up the GitHub OAuth work tonight; asked whether anyone has
  verified the callback URL on Windows.
- Bob and the team confirmed `estimatedHours` can be a float — the
  breakdownTask zod schema already allows `z.number()`.

No blockers raised in chat today.''';

  // ---- Daily Report -----------------------------------------------------

  static String get _today {
    final now = DateTime.now();
    return '${now.year.toString().padLeft(4, '0')}-'
        '${now.month.toString().padLeft(2, '0')}-'
        '${now.day.toString().padLeft(2, '0')}';
  }

  static DailyReport get todayReport => DailyReport(
        date: _today,
        repoId: demoRepoId,
        summary:
            'Sprint 1 skeleton merged. Alice started GitHub OAuth wiring; Bob '
            'drafted the breakdownTask zod schema. No blockers reported.',
        highlights: const [
          'Sprint 1 MVVM skeleton merged (PR #1)',
          'GitHub OAuth flow wired into AuthService',
          'breakdownTask zod schema + cycle detection drafted',
        ],
        blockers: const [
          'Callback URL on Windows not yet verified by anyone',
        ],
        commitThemes: const [
          CommitTheme(
            theme: 'Project skeleton',
            summary: 'MVVM scaffolding and Firebase config placeholders landed.',
            commitCount: 1,
          ),
          CommitTheme(
            theme: 'Auth',
            summary: 'GitHub OAuth provider added; access token persisted.',
            commitCount: 1,
          ),
          CommitTheme(
            theme: 'AI flows',
            summary: 'breakdownTask schema + cycle-detection draft started.',
            commitCount: 1,
          ),
        ],
        commitCount: 3,
        completedTaskIds: const ['task-001'],
        memberContributions: const {
          demoUserId: MemberContribution(
            tasksDone: 1,
            commits: 1,
            githubLogin: 'demo-dev',
            displayName: 'Demo User',
          ),
          aliceId: MemberContribution(
            tasksDone: 0,
            commits: 1,
            githubLogin: 'alice-dev',
            displayName: 'Alice',
          ),
          bobId: MemberContribution(
            tasksDone: 0,
            commits: 1,
            githubLogin: 'bob-ml',
            displayName: 'Bob',
          ),
        },
      );
}
