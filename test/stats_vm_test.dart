import 'package:flutter_test/flutter_test.dart';

import 'package:gitsync/models/app_user.dart';
import 'package:gitsync/models/commit.dart';
import 'package:gitsync/models/member.dart';
import 'package:gitsync/models/task.dart';
import 'package:gitsync/repositories/commit_repo.dart';
import 'package:gitsync/repositories/member_repo.dart';
import 'package:gitsync/repositories/task_repo.dart';
import 'package:gitsync/repositories/user_repo.dart';
import 'package:gitsync/view_models/members_vm.dart';
import 'package:gitsync/view_models/stats_vm.dart';
import 'package:gitsync/view_models/tasks_board_vm.dart';

Commit _commit(String login, {String name = '', String? sha}) => Commit(
      sha: sha ?? login + DateTime.now().microsecondsSinceEpoch.toString(),
      repoId: 'r',
      message: 'm',
      author: CommitAuthor(login: login, name: name, email: ''),
      url: '',
    );

// Hand-rolled fakes (mirrors the repo's other inline test fakes).
class _FakeCommitRepo implements CommitRepository {
  _FakeCommitRepo(this.commits);
  final List<Commit> commits;

  @override
  Future<List<Commit>> fetchAllCommits(String repoId) async => commits;

  @override
  noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeUserRepo implements UserRepository {
  _FakeUserRepo(this.users);
  // uid → user (absent uid resolves to null).
  final Map<String, AppUser> users;

  @override
  Future<AppUser?> getUser(String userId) async => users[userId];

  @override
  noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

AppUser _user(String id, {String githubLogin = '', String name = ''}) =>
    AppUser(
      id: id,
      name: name,
      email: '',
      avatarUrl: '',
      githubLogin: githubLogin,
    );

Task _task(
  String id,
  TaskStatus status, {
  String? assigneeId,
  String? title,
}) =>
    Task(
      id: id,
      title: title ?? id,
      status: status,
      assigneeId: assigneeId,
      createdBy: 'u',
    );

Member _member(String id) => Member(userId: id, role: MemberRole.member);

void main() {
  group('computeContributions', () {
    test('per-member share of done tasks, sorted by done count desc', () {
      final tasks = [
        _task('1', TaskStatus.done, assigneeId: 'alice'),
        _task('2', TaskStatus.done, assigneeId: 'alice'),
        _task('3', TaskStatus.done, assigneeId: 'bob'),
        _task('4', TaskStatus.inProgress, assigneeId: 'alice'), // not done
        _task('5', TaskStatus.todo, assigneeId: 'bob'), // not done
      ];
      final members = [_member('alice'), _member('bob')];

      final contribs =
          StatsViewModel.computeContributions(tasks, members, const {});

      // 3 done total: alice 2 (67%), bob 1 (33%). alice first (higher count).
      expect(contribs.map((c) => c.assigneeId).toList(), ['alice', 'bob']);
      expect(contribs.first.doneCount, 2);
      expect(contribs.first.pct, 67); // 2/3 rounds to 67
      expect(contribs.last.doneCount, 1);
      expect(contribs.last.pct, 33); // 1/3 rounds to 33
    });

    test('excludes unassigned and never-done assignees', () {
      final tasks = [
        _task('1', TaskStatus.done, assigneeId: 'alice'),
        _task('2', TaskStatus.done), // unassigned → excluded
        _task('3', TaskStatus.todo, assigneeId: 'bob'), // never done → no entry
      ];
      final contribs = StatsViewModel.computeContributions(
        tasks,
        [_member('alice'), _member('bob')],
        const {},
      );

      expect(contribs.length, 1);
      expect(contribs.single.assigneeId, 'alice');
      expect(contribs.single.pct, 100);
    });

    test('zero-done edge: no done tasks → empty list', () {
      final tasks = [
        _task('1', TaskStatus.todo, assigneeId: 'alice'),
        _task('2', TaskStatus.inProgress, assigneeId: 'bob'),
      ];
      final contribs = StatsViewModel.computeContributions(
        tasks,
        [_member('alice'), _member('bob')],
        const {},
      );

      expect(contribs, isEmpty);
    });

    test('falls back to the raw id when the assignee is not in the roster', () {
      final tasks = [
        _task('1', TaskStatus.done, assigneeId: 'ghost-user'),
      ];
      final contribs =
          StatsViewModel.computeContributions(tasks, const [], const {});

      expect(contribs.single.label, 'ghost-user');
    });

    test('uses the resolved-name map for labels when present', () {
      final tasks = [_task('1', TaskStatus.done, assigneeId: 'alice')];
      final contribs = StatsViewModel.computeContributions(
        tasks,
        [_member('alice')],
        const {'alice': 'alice-dev'},
      );

      expect(contribs.single.label, 'alice-dev');
    });
  });

  group('buildAuthorGroups (D1 identity canonicalization)', () {
    test('per-author share of all commits, sorted by count desc', () {
      final commits = [
        _commit('alice-dev'),
        _commit('alice-dev'),
        _commit('bob-ml'),
        _commit('alice-dev'),
      ];
      final groups = StatsViewModel.buildAuthorGroups(commits);

      // 4 commits: alice-dev 3 (75%), bob-ml 1 (25%).
      expect(groups.map((g) => g.label).toList(), ['alice-dev', 'bob-ml']);
      expect(groups.first.commitCount, 3);
      expect(groups.first.pct, 75);
      expect(groups.last.commitCount, 1);
      expect(groups.last.pct, 25);
    });

    test('no commits → empty list', () {
      expect(StatsViewModel.buildAuthorGroups(const []), isEmpty);
    });

    test('falls back to the git name, then "unknown", for the label', () {
      final groups = StatsViewModel.buildAuthorGroups([
        _commit('', name: 'No Login'),
        _commit('', name: ''), // neither → 'unknown'
      ]);

      expect(groups.map((g) => g.label).toSet(), {'No Login', 'unknown'});
    });

    test('merges login + name-only commits of one human into one group', () {
      // H030m commits carry login; the GraphQL-backfilled ones carry only the
      // git name 倪嘉駿 — both are the same person and must merge.
      final commits = [
        _commit('H030m', name: '倪嘉駿'),
        _commit('H030m', name: '倪嘉駿'),
        _commit('', name: '倪嘉駿'), // login-less backfill → learns → H030m
        _commit('', name: '倪嘉駿'),
      ];
      final groups = StatsViewModel.buildAuthorGroups(commits);

      expect(groups.length, 1);
      final g = groups.single;
      expect(g.label, 'H030m'); // canonical login casing
      expect(g.login, 'H030m');
      expect(g.commitCount, 4);
      expect(g.pct, 100);
      expect(g.names, contains('倪嘉駿'));
    });

    test('merges name-casing variants (temmie vs Temmie) of one login', () {
      final commits = [
        _commit('temmie', name: 'temmie'),
        _commit('', name: 'Temmie'), // case-insensitive name match → temmie
        _commit('', name: 'TEMMIE'),
      ];
      final groups = StatsViewModel.buildAuthorGroups(commits);

      expect(groups.length, 1);
      expect(groups.single.login, 'temmie');
      expect(groups.single.commitCount, 3);
    });

    test('an unmatched name stays its own group', () {
      final commits = [
        _commit('H030m', name: '倪嘉駿'),
        _commit('', name: 'Stranger'), // no login ever teaches this name
      ];
      final groups = StatsViewModel.buildAuthorGroups(commits);

      expect(groups.length, 2);
      expect(groups.map((g) => g.label).toSet(), {'H030m', 'Stranger'});
      final stranger = groups.firstWhere((g) => g.label == 'Stranger');
      expect(stranger.login, isNull);
    });
  });

  group('name resolution via StatsViewModel', () {
    test('resolves member uids to githubLogin, falling back to name then uid',
        () async {
      final vm = StatsViewModel(
        repoId: 'r',
        commitRepository: _FakeCommitRepo(const []),
        userRepository: _FakeUserRepo({
          'u-login': _user('u-login', githubLogin: 'octocat'),
          'u-name': _user('u-name', name: 'Just A Name'),
          // 'u-missing' is absent → getUser returns null → falls back to uid.
        }),
      );

      vm.updateFromUpstream(
        tasks: _StubTasks([
          _task('1', TaskStatus.done, assigneeId: 'u-login'),
          _task('2', TaskStatus.done, assigneeId: 'u-name'),
          _task('3', TaskStatus.done, assigneeId: 'u-missing'),
        ]),
        members: _StubMembers([
          _member('u-login'),
          _member('u-name'),
          _member('u-missing'),
        ]),
      );

      // Let the async getUser lookups land.
      await Future<void>.delayed(const Duration(milliseconds: 50));

      final labels = {
        for (final c in vm.contributions) c.assigneeId: c.label,
      };
      expect(labels['u-login'], 'octocat');
      expect(labels['u-name'], 'Just A Name');
      expect(labels['u-missing'], 'u-missing');
    });
  });
}

// Minimal upstream-VM stubs so updateFromUpstream can be exercised without the
// real backend-wired view models.
class _StubTasks extends TasksBoardViewModel {
  _StubTasks(this._tasks) : super(repoId: 'r', taskRepository: _NoopTaskRepo());
  final List<Task> _tasks;
  @override
  List<Task> get tasks => _tasks;
}

class _StubMembers extends MembersViewModel {
  _StubMembers(this._members)
      : super(repoId: 'r', memberRepository: _NoopMemberRepo());
  final List<Member> _members;
  @override
  List<Member> get members => _members;
}

class _NoopTaskRepo implements TaskRepository {
  @override
  Stream<List<Task>> streamTasks(String repoId) => const Stream.empty();

  @override
  noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _NoopMemberRepo implements MemberRepository {
  @override
  Stream<List<Member>> streamMembers(String repoId) => const Stream.empty();

  @override
  noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
