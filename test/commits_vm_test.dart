import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:gitsync/models/commit.dart';
import 'package:gitsync/models/commit_graph.dart';
import 'package:gitsync/repositories/commit_repo.dart';
import 'package:gitsync/services/functions_service.dart';
import 'package:gitsync/view_models/commits_vm.dart';

/// Stub repo whose stream errors on demand — reproduces the live-mode bug
/// where a parse error inside the snapshot map() hung the Commits tab spinner.
class _StubCommitRepository implements CommitRepository {
  _StubCommitRepository({this.failFirst = false});

  bool failFirst;
  int subscriptions = 0;

  @override
  Stream<List<Commit>> streamRecent(String repoId, {int limit = 50}) {
    subscriptions += 1;
    if (failFirst) {
      failFirst = false; // next subscribe (retry) succeeds
      return Stream<List<Commit>>.error(StateError('parse failure'));
    }
    return Stream.value(const <Commit>[]);
  }

  @override
  Stream<List<Commit>> streamRange(
    String repoId,
    DateTime startDay,
    DateTime endDay,
  ) => streamRecent(repoId);

  @override
  Stream<List<Commit>> streamCommitsForDay(String repoId, DateTime day) =>
      streamRecent(repoId);

  @override
  Future<Commit?> getCommit(String repoId, String sha) async => null;

  @override
  Future<List<Commit>> fetchAllCommits(String repoId) async => const [];
}

/// Captures the args passed to explainCommit so the W6 wiring (force + language)
/// is observable. getCommitGraph returns an empty graph (the VM calls it on
/// construction); every other callable throws via noSuchMethod.
class _CapturingFunctionsService implements FunctionsService {
  bool? lastForce;
  String? lastLanguage;
  int explainCalls = 0;

  @override
  Future<String> explainCommit({
    required String repoId,
    required String sha,
    bool force = false,
    String? language,
    String? runId,
  }) async {
    explainCalls++;
    lastForce = force;
    lastLanguage = language;
    return 'explanation for $sha';
  }

  @override
  Future<CommitGraph> getCommitGraph({
    required String repoId,
    String? startDate,
    String? endDate,
    bool force = false,
  }) async =>
      const CommitGraph(commits: [], branches: []);

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError(invocation.memberName.toString());
}

void main() {
  group('Commit.fromMap legacy webhook shapes', () {
    test('ISO-string committedAt and numeric filesChanged do not throw', () {
      // Exactly what the old githubWebhook handler wrote.
      final commit = Commit.fromMap({
        'repoId': 'octocat_hello',
        'message': 'fix: something',
        'author': {'login': 'octocat', 'name': 'Octo', 'email': ''},
        'url': '',
        'filesChanged': 2, // legacy: a count, not a list
        'committedAt': '2026-06-02T00:00:00Z', // legacy: ISO string
      }, 'abc123');

      expect(commit.filesChanged, isEmpty);
      expect(commit.committedAt.toDate().toUtc(), DateTime.utc(2026, 6, 2));
    });

    test('canonical Timestamp + path list still parse', () {
      final ts = Timestamp.fromDate(DateTime.utc(2026, 6, 3));
      final commit = Commit.fromMap({
        'filesChanged': ['a.ts', 'b.ts'],
        'committedAt': ts,
      }, 'def456');

      expect(commit.filesChanged, ['a.ts', 'b.ts']);
      expect(commit.committedAt, ts);
    });

    test('garbage committedAt degrades to null instead of throwing', () {
      final commit = Commit.fromMap({'committedAt': 'not-a-date'}, 'ghi789');
      // Falls back to "now" via the committedAt getter — just must not throw.
      expect(commit.committedAt, isA<Timestamp>());
    });
  });

  group('CommitsViewModel stream errors', () {
    test('stream error stops the spinner and surfaces the message', () async {
      final repo = _StubCommitRepository(failFirst: true);
      final vm = CommitsViewModel(repoId: 'r', commitRepository: repo);
      await Future<void>.delayed(Duration.zero);

      expect(vm.loading, isFalse, reason: 'spinner must not hang forever');
      expect(vm.streamError, contains('parse failure'));
    });

    test('retry() re-subscribes and clears the error', () async {
      final repo = _StubCommitRepository(failFirst: true);
      final vm = CommitsViewModel(repoId: 'r', commitRepository: repo);
      await Future<void>.delayed(Duration.zero);
      expect(vm.streamError, isNotNull);

      vm.retry();
      await Future<void>.delayed(Duration.zero);

      expect(repo.subscriptions, 2);
      expect(vm.streamError, isNull);
      expect(vm.loading, isFalse);
    });
  });

  group('CommitsViewModel W6 explain language', () {
    test('recompute (force) forwards the mapped language to explainCommit',
        () async {
      final functions = _CapturingFunctionsService();
      final vm = CommitsViewModel(
        repoId: 'r',
        commitRepository: _StubCommitRepository(),
        functionsService: functions,
      );
      await Future<void>.delayed(Duration.zero);

      await vm.explain('sha1', force: true, language: 'Traditional Chinese');

      expect(functions.lastForce, isTrue);
      expect(functions.lastLanguage, 'Traditional Chinese');
      expect(vm.explanationFor('sha1'), 'explanation for sha1');
    });

    test('first tap (no force) sends no language — default-language path',
        () async {
      final functions = _CapturingFunctionsService();
      final vm = CommitsViewModel(
        repoId: 'r',
        commitRepository: _StubCommitRepository(),
        functionsService: functions,
      );
      await Future<void>.delayed(Duration.zero);

      await vm.explain('sha2');

      expect(functions.lastForce, isFalse);
      expect(functions.lastLanguage, isNull);
    });
  });
}
