# Journal - opal (Part 1)

> AI development session journal
> Started: 2026-06-02

---



## Session 1: Trellis team setup + implement addRepo callable

**Date**: 2026-06-02
**Task**: Trellis team setup + implement addRepo callable
**Branch**: `feature/add-repo-callable`

### Summary

Set up Trellis for team use (developer identity, develop-based git-flow convention in spec + docs). Implemented addRepo Cloud Function (URL parse, GitHub access verify, best-effort webhook registration, atomic 3-doc write under apps/gitsync/) with the project's first backend test suite (jest+ts-jest, 13 tests). Recorded course constraint: Final Demo limited to Flutter+Firebase; Cloud Functions confirmed allowed.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `0012694` | (see git log) |
| `d8b69eb` | (see git log) |
| `147f1e7` | (see git log) |
| `7396fbf` | (see git log) |
| `582a706` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: GitHub OAuth finishing + first live deploy (addRepo/OAuth e2e)

**Date**: 2026-06-02
**Task**: GitHub OAuth finishing + first live deploy (addRepo/OAuth e2e)
**Branch**: `feature/github-oauth`

### Summary

Finished GitHub OAuth (module E): fixed createdAt-reset bug via transaction, added kIsWeb signInWithPopup web path, auth_vm unit tests (hand-rolled fake, no new deps), cleaned E-module TODO, enhanced SETUP B.4. Upgraded local Flutter to 3.44.1. Then deployed addRepo + githubWebhook to gitsync-645b3 and verified end-to-end: live GitHub OAuth login + add repo both work. Recorded the three first-deploy gotchas (secret prompt, build SA permission, Cloud Run allow-unauthenticated) in SETUP and MEMORY.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `0cdc8e0` | (see git log) |
| `730466e` | (see git log) |
| `fac85fd` | (see git log) |
| `7ddc050` | (see git log) |
| `11feff3` | (see git log) |
| `eb23e81` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: Implement removeRepo (backend + delete UI)

**Date**: 2026-06-02
**Task**: Implement removeRepo (backend + delete UI)
**Branch**: `feature/remove-repo`

### Summary

Implemented removeRepo callable (owner check, best-effort deleteWebhook, member-pointer cleanup + recursiveDelete of repo + subcollections) with 7 unit tests. Added minimal delete UI: RepoListViewModel.removeRepo + per-row delete button with confirm dialog, list auto-updates via stream. Captured recursiveDelete cleanup-ordering in backend spec. All lint/typecheck/tests green.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ee9dc29` | (see git log) |
| `070bbf8` | (see git log) |
| `aeb980a` | (see git log) |
| `4e99e38` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: breakdownTaskFlow Step 1-6 + add_todo spec input

**Date**: 2026-06-02
**Task**: breakdownTaskFlow Step 1-6 + add_todo spec input
**Branch**: `feature/breakdown-flow`

### Summary

Implemented breakdownTaskFlow (context from pasted SPEC.md + repo info -> OpenAI structured output -> detectCycles+re-prompt -> pre-gen taskIds -> index->taskId translation -> batch write tasks as source:ai_breakdown; flow does not touch isBreakingDown, handler owns lock). Shallow-graph prompt (~5-12 top-level TODOs). Fixed add_todo setState button bug + enlarged spec paste box + mounted guard. Boundary-mocked test suite (32 green). Specs: handler/flow lock-ownership division, OpenAI .beta.parse SDK-path convention. Deployed + live-verified: TODOs generate with dependsOn populated. Next: render dependency graph in TasksBoard Graph tab (currently stub).

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `329735f` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 5: Task dependency graph in TasksBoard Graph tab

**Date**: 2026-06-02
**Task**: Task dependency graph in TasksBoard Graph tab
**Branch**: `feature/task-graph-view`

### Summary

Replaced the Graph-tab stub in TasksBoardPage with TaskGraphTab: renders a dependency DAG from vm.tasks using the graphview package (1.5.1) + Sugiyama top-down layout in an InteractiveViewer. Nodes = tasks (status-colored cards, tap -> goTaskDetails), edges = prerequisite->dependent, dangling edges skipped, isolated nodes shown, empty-state placeholder. Added graphview dep (user-approved). Spec: graphview/DAG convention (use plain GraphView + own InteractiveViewer not GraphView.builder; addNode every node; Node.Id key round-trip). Live-verified by user (flutter run). analyze clean, 7 tests green.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `6b31529` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: GitHub sync: webhook ingestion + task/issue/PR triggers

**Date**: 2026-06-02
**Task**: GitHub sync: webhook ingestion + task/issue/PR triggers
**Branch**: `feature/github-webhook`

### Summary

End-to-end GitHub integration. Webhook (HMAC verify on rawBody + idempotency + dispatch -> raw writes to commits/pullRequests/issues) + githubClient.createIssue. Triggers: onTaskCreated mirrors task->GitHub issue (stores githubIssueNumber), onCommitCreated parses #N->linkedTaskIds + embedding + aiSummary (Rule D), onPRMerged (onDocumentWritten, parses closing refs -> txn mark done + counters), onIssueWritten (new, reverse-sync). tools/issueRefs + taskStatus. Linking via issue-mirror (#N). Check caught a production bug: onPRMerged was onDocumentUpdated but the PR doc is created already merged -> never fired; fixed to onDocumentWritten + spec Rule E. 8 suites / 65 tests green. Deployed 2026-06-02 (githubWebhook public-access opened on Cloud Run); onTaskCreated live-verified end-to-end. Remaining triggers (onCommitCreated / onPRMerged / onIssueWritten) deployed but not yet live-tested.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `c19231d` | (see git log) |

### Testing

- [OK] Unit: 8 suites / 65 tests green (boundary-mocked).
- [OK] Live (2026-06-02): deployed githubWebhook + 4 triggers; opened public invoker on `githubwebhook` Cloud Run service. **onTaskCreated** verified end-to-end — creating a new task auto-creates a GitHub issue and writes `githubIssueNumber` back to the task doc.
- [OK] Live (2026-06-02): onCommitCreated (#N link + aiSummary), onPRMerged (closes #N -> task done + counters), onIssueWritten (close/reopen reverse-sync) — all verified end-to-end.

### Status

[OK] **Completed** — code + full live verification (githubWebhook + all 4 triggers). Merged develop -> main.

### Next Steps

- Next feature: #3 assignTaskFlow (module D dynamic task assignment).


## Session 7: assignTaskFlow — agentic dynamic task assignment

**Date**: 2026-06-02
**Task**: assignTaskFlow — agentic dynamic task assignment
**Branch**: `feature/assign-task-flow`

### Summary

Implemented assignTaskFlow: OpenAI function-calling agentic loop (max 5 rounds, 4 tools: readTeamState=members+users join, searchMemberCommits=findNearest repoId+author.login prefilter, getTaskDependents, finalizeAssignment) picks best assignee by load/expertise/commit-history/dependents. Auto-apply: writes tasks/{taskId}.assigneeId + rebalances activeIssueCount in a transaction (reassign old-1/new+1, atomic). Pre-checks (task-done/no-member throw, single-member shortcut skips OpenAI) + lowest-load fallback. trellis-check caught a latent prod bug in the already-shipped handlePush: commit author handle persisted as author.username but schema+consumer use author.login -> vector search silently returned []; fixed + captured as database-guidelines Rule F. Discord-chat RAG deferred to future TODO (readTeamState already returns discordUserId for it). 9 suites/73 tests green. Not yet deployed; needs new commits vector index.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `7533790` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 8: onTaskUpdated — auto-assign downstream on done + FCM notify

**Date**: 2026-06-02
**Task**: onTaskUpdated — auto-assign downstream on done + FCM notify
**Branch**: `feature/auto-assign-on-done`

### Summary

Implemented the onTaskUpdated trigger (was a stub): on a task's status transition to done, query downstream tasks (dependsOn array-contains), keep only those whose every prerequisite is now done (ready filter, in-code), auto-assign the unassigned ones by reusing assignTaskFlow (auto-apply owns its counters — trigger touches no counters), and FCM-notify each newly-ready task's assignee (new tools/notify.ts, reads users/{uid}.fcmToken, best-effort). Transition guard (before!=done && after==done) prevents recursion when assignTaskFlow writes downstream assigneeId. Per-downstream try/catch = best-effort. onTaskUpdated now declares secrets:[openaiKey] + timeoutSeconds 300. trellis-check passed clean (0 issues): recursion trace, no double-counting, ready filter, data-flow (fcmToken written by Flutter user_repo), best-effort all verified. Added database-guidelines Rule G (single array-contains + in-code filter over manual composite index). 10 suites/84 tests green. Not yet deployed/live-tested.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `dfa13f9` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 9: addRepo join-as-member on duplicate

**Date**: 2026-06-02
**Task**: addRepo join-as-member on duplicate
**Branch**: `feature/add-repo-join-member`

### Summary

Fixed addRepo rejecting a second collaborator with already-exists. Now: permission check (push/admin via verifyRepoAccess) runs before a create-vs-join split. New repo -> owner + webhook + 3 docs (unchanged). Existing repo -> join path (skips webhook): if already a member, idempotent {repoId, alreadyMember:true} no writes; else batch set members/{uid} role member + users/{uid}/repos/{repoId} + repos/{repoId}.memberIds arrayUnion(uid), never overwriting webhookSecret/createdBy. Non-collaborator still rejected. Frontend unchanged (repo-list stream reads repos.where memberIds array-contains uid, which the join writes). trellis-check 0 issues; noted firestore.rules is still the DEFAULT OPEN ruleset (allow read/write until 2026-06-25) — security follow-up, out of scope here. 10 suites/86 tests green.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `041d19d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 10: Fix: dynamic assignment hard-failed on missing commits vector index

**Date**: 2026-06-03
**Task**: Fix: dynamic assignment hard-failed on missing commits vector index
**Branch**: `feature/assign-commit-search-resilient`

### Summary

Live debug: onTaskUpdated auto-assignment left downstream assigneeId null. Logs showed assignTaskFlow ran the agentic loop but searchMemberCommits findNearest threw 9 FAILED_PRECONDITION (missing vector index) which propagated and killed the whole assignment. Root causes: (1) optional commit-search signal was not best-effort — one throw aborted the flow; (2) firestore.indexes.json declared the commits vector indexes COLLECTION_GROUP but the query is .collection() = COLLECTION scope, so even deploying built the wrong index. Fix: wrap embed+findNearest+map in try/catch -> return [] + warn (assignment now finalizes on workload/expertise/dependents even with no index and no commits — demo no longer needs the index); changed both commits vector indexes to queryScope COLLECTION; left discordMessages COLLECTION_GROUP (no findNearest consumer). Confirmed user's remove/re-add/regenerate test flow was NOT the cause. Extended error-handling spec: optional/secondary signal tools must be best-effort + must not hard-depend on a user-deployed index + match index queryScope to query. trellis-check 0 issues; 12 suites/98 tests green. User to redeploy functions:onTaskUpdated,assignTask; index deploy optional now.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `aae8c7e` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 11: push 自動判定 task 完成並設為 done（AI judge + onCommitCompletesTask trigger）

**Date**: 2026-06-14
**Task**: push 自動判定 task 完成並設為 done（AI judge + onCommitCompletesTask trigger）
**Branch**: `feature/push-auto-complete-task`

### Summary

新增 onCommitCompletesTask trigger：commit 推到預設分支且含 #N 時，由 LLM (judgeTaskCompletion) 判斷對應 task 是否完成，confidence>=0.8 則 markTaskDone。handlePush 以獨立 set(merge) 標記 onDefaultBranch 解決 first-seen/idempotency 限制。check 階段修掉 markIdempotent 搶 key 餓死 onCommitCreated 的 bug（guard 須排在 markIdempotent 前），spec 已記錄。377 tests 全綠。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `4cc9a57` | (see git log) |
| `2769a52` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
