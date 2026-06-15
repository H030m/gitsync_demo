# Rich task detail cards: GitHub issue sync + AI handoff docs + push to next assignee

## Goal

Make the task-detail card show the full picture of a task (subtasks/dependencies,
acceptance criteria = "實作細節", assignee picker that stays in sync with the linked
GitHub issue), and when a prerequisite task is completed, have AI auto-generate a
**handoff document** from the real project signals (commits + Discord chat) and push
it to the next assignee.

## What I already know (repo inspection 2026-06-06)

**The backend plumbing is ~80% already built.** Key findings:

### Task model already has every field we need
`lib/models/task.dart:39-150` — `title, description, status(todo/inProgress/done),
assigneeId, dependsOn: List<String>, githubIssueNumber, linkedPRNumbers,
acceptanceCriteria: List<String>, handoffDoc, handoffGeneratedAt, source, parentTaskId`.
Subtasks today are modeled as separate Tasks linked by `parentTaskId` + `dependsOn`
(the breakdown flow writes them). `lib/models/sub_task.dart` is only the transient
AI-breakdown output, not persisted.

### GitHub issue sync — FULLY implemented both directions
- Task → Issue: `triggers/onTaskCreated.ts` calls `githubClient.createIssue(...)`,
  writes `githubIssueNumber` back.
- Issue/PR → Task: `githubWebhook.ts` handles `push/pull_request/issues`;
  `onIssueWritten.ts` reverse-syncs issue closed/reopened → task done/todo;
  `onPRMerged.ts` marks linked tasks done; `onCommitCreated.ts` links `#N` → tasks.
- **Gap**: `createIssue` does NOT set the GitHub issue *assignee*. App-side assignment
  (`assignTo`) writes `task.assigneeId` only — it never calls the GitHub API to set
  the issue's assignee. So "負責人和 issue 連動" is the net-new part here.

### Auto-dispatch + notify on completion — implemented, but delivery is broken
- `triggers/onTaskUpdated.ts`: on task→done, finds downstream tasks via
  `where('dependsOn','array-contains', doneId)`, checks all prereqs done, auto-assigns
  unassigned ones via `assignTaskFlow`, then calls `notifyAssignee(...)` (FCM).
- `tools/notify.ts:notifyAssignee` reads `users/{uid}.fcmToken` and sends FCM.
- **Gap (delivery)**: `PushMessagingService.initialize()` is NEVER called on the client
  (`lib/main.dart:66` only registers the Provider), so `users/{uid}.fcmToken` is never
  written → every notify logs "no fcmToken, skipping". See sibling task
  `.trellis/tasks/06-03-wire-fcm-notifications/prd.md`.

### AI handoff flow — STUB only
- `functions/src/flows/generateHandoff.ts` throws "not implemented".
- Handler `handlers/generateHandoff.ts` + prompt skeleton `prompts/generateHandoff.ts`
  exist (callable `generateHandoff(repoId, taskId)`, 300s, planned agentic
  draft→self-review loop with tools: readTeamRoster, findDownstreamTask,
  listRelatedCommits, getCommitDiff, searchDiscordMessages, draftHandoff, finalizeHandoff).
- It is wired NOWHERE — not into onTaskUpdated, not into any UI button.
- Data sources it would read already exist: commits (`tools/dailyIntel.ts`
  searchPastCommits / listDayCommits), Discord (`tools/discordSearch.ts`
  searchDiscordMessages / getDaySummary), downstream task + team roster.

### Task detail UI — skeleton only
- `lib/views/tasks/task_details_page.dart` shows ONLY title + status chip +
  description + handoffDoc. Missing: assignee, dependencies, acceptance criteria,
  subtasks, GitHub issue link, linked PRs. (Header comment: "TODO implement per
  prototype tasks/TaskDetails.tsx".)
- `lib/views/tasks/widgets/task_graph_tab.dart` already renders the dependency DAG
  (graphview), tap node → TaskDetailsPage.
- VM ops exist: `TasksBoardViewModel.assignTo / updateStatus`; repo has
  `getDependentsOf`. AI flow client calls live in `functions_service.dart`.

### Conventions
- LLM = OpenAI (`config.ts` getOpenAI; MODELS.reasoning=gpt-4o, fast=gpt-4o-mini).
- Callables: `onCall({region:'asia-east1', secrets:[openaiKey]})`, auth-gated,
  return plain object. Client: `functions_service.dart` + Fake impl required.
- Firestore: `apps/gitsync/repos/{repoId}/tasks/{taskId}`.

## So the actual work splits into 4 separable slices

1. **Rich task-detail UI** (Flutter, frontend-only) — render subtasks (children +
   deps), acceptance criteria, assignee picker, GitHub issue link, linked PRs, status.
2. **Assignee ↔ GitHub issue sync** (backend) — when `assigneeId` changes, set the
   GitHub issue assignee via Octokit; map app user → GitHub login.
3. **AI handoff doc** (backend) — implement `generateHandoffFlow` (agentic, reads
   commits + Discord + downstream task), wire it to auto-fire when a prerequisite
   completes (in `onTaskUpdated`, before notify), store to `handoffDoc` + show in UI.
4. **Push delivery** (client wiring) — call `PushMessagingService.initialize(uid)`
   after sign-in so the already-built notify path actually reaches the device; tap →
   route to the task. (= sibling task 06-03.)

## Scope — all 4 slices IN (confirmed 2026-06-06)

1. Rich task-detail UI · 2. AI handoff doc · 3. Push delivery · 4. Assignee↔issue sync.

## Resolved

* [assignee↔issue mapping] `AppUser.githubLogin` already exists
  (`lib/models/app_user.dart:12`, stored at `users/{uid}.githubLogin`). Assignment
  sync = after writing `assigneeId`, look up the assignee's `githubLogin` and call
  Octokit `issues.update`/`addAssignees` (best-effort, mirrors createIssue style).

## Decisions (ADR-lite)

* **Handoff trigger** = **auto + manual**. Auto-generate inside `onTaskUpdated` when a
  downstream task becomes ready (all prereqs done), store to `handoffDoc` +
  `handoffGeneratedAt`, then notify. Plus a "Regenerate handoff" button in the detail
  UI (force=true). Generation is best-effort — failure must NOT block the notify path;
  skip if `handoffDoc` already set unless force.
* **Push delivery** = **mobile FCM + in-app banner**. Wire
  `PushMessagingService.initialize(uid)` after sign-in so the existing `notifyAssignee`
  path reaches the phone; ALSO add a Firestore-listener in-app banner
  (`tasks where assigneeId == me`, newly-appearing) for when the app is foregrounded.
  No web push (no service worker / VAPID) in this task.

## Requirements

### Slice 1 — Rich task-detail UI (`lib/views/tasks/task_details_page.dart`)
* Show, beyond title/status/description: **subtasks** (child tasks via `parentTaskId`
  + their status), **dependencies** (`dependsOn` → titles + status, tappable),
  **implementation details** = `acceptanceCriteria` checklist, **assignee** with an
  inline picker (repo members), **GitHub issue** link (`githubIssueNumber` → issue URL),
  **linked PRs** (`linkedPRNumbers`), and the **handoff doc** (already partly rendered).
* Assignee picker calls existing `TasksBoardViewModel.assignTo`. Lists repo members.
* Follows component-guidelines (colorScheme/AppDimens, Consumer<VM>, NavigationService).

### Slice 2 — Push delivery (client wiring)
* Call `PushMessagingService.initialize(uid)` after successful sign-in (auth state
  listener / shell guard), handle permission-denied gracefully.
* In-app banner: stream `tasks where assigneeId == currentUid`; surface a banner/snackbar
  when a task newly becomes mine. Tap (FCM `onMessageOpenedApp` + banner) → route to the
  task detail via NavigationService (replace NotifyScreen placeholder routing).

### Slice 3 — AI handoff doc (`functions/src/flows/generateHandoff.ts`)
* Implement `generateHandoffFlow({repoId, taskId})` per the existing skeleton: agentic
  draft→self-review reading the prerequisite(s)' real commits (`tools/dailyIntel`) +
  Discord (`tools/discordSearch`) + the downstream task + team roster; write
  `handoffDoc` + `handoffGeneratedAt` on the downstream task. `taskId` = the downstream
  (receiving) task; it reads its `dependsOn` prerequisites' signals.
* Wire into `onTaskUpdated`: after a downstream task is found ready, call
  generateHandoff (best-effort, before/with notify). Add `generateHandoff` to
  `functions_service.dart` (+ Fake) and a "Regenerate" button (force) in Slice 1 UI.

### Slice 4 — Assignee ↔ GitHub issue sync (backend)
* When a task's `assigneeId` changes and it has a `githubIssueNumber`, set the GitHub
  issue assignee: look up assignee `users/{uid}.githubLogin`, call Octokit
  `issues.addAssignees` (new helper in `services/githubClient.ts`). Best-effort, mirrors
  `createIssue`. Trigger via `onTaskUpdated` (assignee-changed branch) or in
  `applyAssignment`.

## Acceptance Criteria

* [ ] Task detail page renders subtasks, dependencies, acceptance criteria, assignee
  (with working picker), GitHub issue link, linked PRs, and handoff doc.
* [ ] Signing in writes `users/{uid}.fcmToken`; a dependency completing delivers a
  push to the next assignee's device AND an in-app banner if foregrounded; tapping
  opens that task.
* [ ] Completing a prerequisite auto-generates a handoff doc on each newly-ready
  downstream task (stored on the doc); a manual "Regenerate" button works; generation
  failure does not block assignment/notify.
* [ ] Changing a task's assignee sets the linked GitHub issue's assignee (when the
  user has a githubLogin and the issue exists).
* [ ] `flutter analyze` + flutter tests green; `functions` build + tests green; Fake
  impls updated so `BACKEND=fake` runs.

## Definition of Done
* Tests added/updated (flutter widget/unit + functions unit for generateHandoff +
  issue-assignee sync). Lint/typecheck green. Fake service updated. Docs/spec notes
  if new patterns emerge.

## Out of Scope
* Web push (service worker / VAPID).
* Re-architecting subtasks into an embedded list (keep parentTaskId + dependsOn).
* Encrypting GitHub tokens (separate hardening task).
* Editing acceptance criteria / subtasks inline (display-first; editing later).

## Out of Scope (tentative)

* Re-architecting subtasks into an embedded list (keep parentTaskId + dependsOn model).
* Encrypting GitHub tokens (separate hardening task).

## Technical Notes

* dependsOn is real taskIds (string), not indices — see MEMORY.md "dependsOn type contract".
* Day boundaries Asia/Taipei (UTC+8). Region asia-east1.
* Final-demo constraints on FCM (Firebase OK; web push fiddly) — check team memory.
</content>
</invoke>
