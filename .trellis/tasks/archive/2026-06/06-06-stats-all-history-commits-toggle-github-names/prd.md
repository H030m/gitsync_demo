# Stats: all-history commit contribution toggle + GitHub names

## Decisions (user-confirmed)

1. 貢獻度 tab gains a toggle: **commit 佔比 / 任務佔比** — BOTH computed from
   ALL history (never the Daily page's loaded window).
   * Commit basis: per-author share of ALL commit docs in Firestore
     (collection-wide fetch, labels = author.login → already GitHub names).
   * Task basis: the existing done-task share (prototype definition).
2. Member labels everywhere in Stats (進度表 rows + task-基準 pie slices)
   resolve to GitHub names: join members' userIds → users/{uid}
   (AppUser.githubLogin, fallback name, fallback uid) via UserRepository.
   No more raw UIDs ("亂碼").

## Requirements

* CommitRepository gains `fetchAllCommits(repoId)` (one-shot collection get;
  fake repo parity). StatsViewModel takes repoId + CommitRepository +
  UserRepository, loads all commits + resolves member names asynchronously
  (cached map), exposes `commitContributions` alongside the task-based
  `contributions`; loading flag while fetching.
* 貢獻度 tab UI: compact SegmentedButton (commit / 任務) above the pie;
  caption text switches accordingly (commit: 全部 commit 累計的貢獻度;
  task: 已完成的任務累計的貢獻度). Pie/legend/in-slice names unchanged
  otherwise.
* 進度表 rows show resolved GitHub names.
* Tests: VM units for commit share math + name resolution fallback; widget
  test toggles the basis and asserts both captions/legends.

## Acceptance Criteria

* [ ] Pie (commit basis) reflects all commits regardless of the Daily range.
* [ ] No raw UID appears anywhere in Stats when the user has a githubLogin.
* [ ] flutter analyze (known info only) + flutter test green; functions
  untouched.
