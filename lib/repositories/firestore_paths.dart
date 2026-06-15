// Centralized Firestore path constants. **All collections live under
// `apps/gitsync/`** (per MEMORY.md 2026-05-20 decision; never write to the
// root as `users/` or `repos/`).

class FirestorePaths {
  FirestorePaths._();

  static const _root = 'apps/gitsync';

  // Root collections.
  static const users = '$_root/users';
  static const repos = '$_root/repos';
  static const idempotencyKeys = '$_root/idempotencyKeys';

  static String user(String userId) => '$users/$userId';
  static String repo(String repoId) => '$repos/$repoId';

  // User subcollections.
  static String userRepos(String userId) => '${user(userId)}/repos';

  // Repo subcollections.
  static String members(String repoId) => '${repo(repoId)}/members';
  static String tasks(String repoId) => '${repo(repoId)}/tasks';
  static String commits(String repoId) => '${repo(repoId)}/commits';
  static String pullRequests(String repoId) => '${repo(repoId)}/pullRequests';
  static String discordMessages(String repoId) =>
      '${repo(repoId)}/discordMessages';
  static String discordDigests(String repoId) =>
      '${repo(repoId)}/discordDigests';
  static String fetchRequests(String repoId) =>
      '${repo(repoId)}/fetchRequests';
  static String dailyReports(String repoId) => '${repo(repoId)}/dailyReports';

  /// Agent tool-trace runs (askRepo / generateHandoff). One doc per run, keyed
  /// by the client-generated runId; written only by Cloud Functions (admin SDK),
  /// streamed read-only by the client.
  static String agentRuns(String repoId) => '${repo(repoId)}/agentRuns';
  static String agentRun(String repoId, String runId) =>
      '${agentRuns(repoId)}/$runId';
}
