# Implement githubWebhook: sync GitHub push/PR events to tasks

## Goal

Make the core "GitSync" chain work: a GitHub **push** / **PR merge** flows through
the `githubWebhook` endpoint into Firestore, and the matching Firestore trigger
updates tasks (the headline demo: **merge a PR → its linked task auto-marks done**).
Today `githubWebhook` and the `onCommitCreated` / `onPRMerged` / `onTaskCreated`
triggers are all stubs.

## What I already know (from repo inspection + ARCHITECTURE §6.3)

* **`githubWebhook`** (`handlers/githubWebhook.ts`) — stub. Contract: verify
  HMAC-SHA256 (`x-hub-signature-256`) against `repos/{repoId}.webhookSecret` →
  idempotency via `x-github-delivery` → dispatch by `x-github-event` → write RAW
  docs only (no AI, no cross-doc). Must respond 200 within ~10s.
  * `handlePush`: write `repos/{repoId}/commits/{sha}` (message/author/url/stats).
  * `handlePR` (only `action==closed && merged==true`): write
    `repos/{repoId}/pullRequests/{n}` (title, state:'merged', commitShas,
    head/base branch, mergedAt).
  * `handleIssue`: sync issue→task fields (optional).
* **Triggers** (all stubs, idempotency guard already wired via `markIdempotent`):
  * `onCommitCreated`: parse `#N` → `linkedTaskIds`; (optional) embedding +
    aiSummary. `shouldSkipEmbedding()` filter already exists.
  * `onPRMerged`: txn → mark `linkedTaskIds` tasks `done` + increment
    `members/{assigneeId}.completedTaskCount`.
  * `onTaskCreated`: stub; comment says "create a matching GitHub issue (if repo
    wants issues mirrored)" — NOT implemented.
* **Infra ready**: `markIdempotent` (tools/idempotency.ts), `addRepo` already
  registers the webhook + stores `webhookSecret`, `githubClient` has
  getOctokit/getRecentCommits/verifyRepoAccess/registerWebhook/deleteWebhook
  (NO createIssue yet). `Task.githubIssueNumber` field exists (nullable).
* **Concurrency rules** (ARCHITECTURE §4.4): counters via `FieldValue.increment`;
  cross-doc via `runTransaction` with in-txn idempotent read; Rule D (slow calls
  outside the idempotency txn).

## Decision Q1 — linking via GitHub issue mirror (`#N`)

Chosen: **mirror each task as a GitHub issue**. This pulls `onTaskCreated` into
scope:
* `onTaskCreated` (idempotent): read the owner token from
  `users/{createdBy}.githubAccessToken`, call `githubClient.createIssue(...)`,
  store `githubIssueNumber` back on the task doc (guard: skip if already set).
* `githubClient.createIssue(owner, repo, token, {title, body})` — new method.
* `onCommitCreated`: parse `#N` closing refs from the message → resolve task by
  `githubIssueNumber` (Firestore query) → set `commit.linkedTaskIds`.
* `onPRMerged`: parse closing keywords (`closes/fixes/resolves #N`) from the
  merged PR's title+body → resolve tasks by `githubIssueNumber` → txn mark `done`
  + increment `members/{assigneeId}.completedTaskCount` (idempotent in-txn read).

Consequences: biggest scope of the three options; needs outbound GitHub calls
from triggers (token fetch) and an issue→task reverse lookup. Most GitHub-native
demo ("merge the PR that closes #3 → task auto-completes").

## Open Questions

* **Q1 — linking mechanism** (gates scope): GitHub-issue mirror (`#N`) vs
  branch-name convention vs text marker.
* Q2 — defer commit AI enrichment (embedding + aiSummary in onCommitCreated)?
* Q3 — events now: push + PR-merged only, defer issues/issue_comment?

## Decisions Q2 / Q3 (full scope)

* **Q2 = include commit AI enrichment**: `onCommitCreated` does `#N`→linkedTaskIds
  AND embedding (`tools/embedding.ts` → `messageEmbedding: FieldValue.vector(...)`)
  AND `aiSummary` via `MODELS.fast` (gpt-4o-mini). All OpenAI/GitHub calls happen
  AFTER `markIdempotent` commits (Rule D); `shouldSkipEmbedding()` short-circuits.
* **Q3 = push + PR + inbound issue**. Adds a reverse-sync path for issues edited
  directly on GitHub.

### Inbound-issue data path (new design from Q3)

Keep the "webhook writes raw, trigger does logic" rule:
* `handleIssue` (webhook): on `issues` events, upsert raw
  `repos/{repoId}/issues/{issueNumber}` `{ number, state, title, action, updatedAt }`.
* **NEW trigger `onIssueWritten`** (`onDocumentWritten` on `issues/{n}`,
  idempotent): when state → `closed`, find the task with that `githubIssueNumber`
  and mark it `done`; when → `reopened`/`open`, revert to `todo`. Register in
  `index.ts`.

## Requirements

* `githubClient.createIssue(owner, repo, token, {title, body})` — new.
* `githubWebhook`: HMAC verify (raw body, timingSafeEqual) → idempotency
  (`x-github-delivery`) → dispatch by `x-github-event` → raw writes only:
  * `handlePush` → `commits/{sha}`; `handlePR` (closed+merged) →
    `pullRequests/{n}`; `handleIssue` → `issues/{n}`.
* `onTaskCreated` (idempotent): create mirror GitHub issue via owner token
  (`users/{createdBy}.githubAccessToken`), store `githubIssueNumber` (skip if set).
* `onCommitCreated`: `#N`→`linkedTaskIds` + embedding + `aiSummary` (Rule D order).
* `onPRMerged`: parse closing keywords from PR title+body → resolve tasks by
  `githubIssueNumber` → txn mark `done` + `FieldValue.increment` the assignee's
  `completedTaskCount` (idempotent in-txn read).
* `onIssueWritten` (NEW): reverse-sync issue state → task status.
* Backend tests (boundary-mock) for each piece.

## Acceptance Criteria (evolving)

* [ ] Invalid signature → 401; valid → 200 fast; duplicate delivery → 200 no-op.
* [ ] PR-merged event writes `pullRequests/{n}`; `onPRMerged` marks the linked
      task(s) `done` exactly once and bumps the assignee's completedTaskCount.
* [ ] Push writes `commits/{sha}`; linked task(s) resolved per Q1.
* [ ] Backend lint/typecheck/tests green.

## Definition of Done

* Tests added; lint/typecheck/jest green.
* Specs updated (webhook/trigger conventions, linking mechanism).
* Deploy commands + any new Cloud Run public-access noted for the user.
* Live-verified end-to-end (user pushes a real commit / merges a real PR).

## Out of Scope (explicit)

* `discordMessageIngest` + `onDiscordMessageCreated` (separate task).
* assignTaskFlow (next task, #3).
* Vector search UI.

## Technical Notes

* HMAC: `crypto.createHmac('sha256', secret).update(rawBody).digest('hex')`,
  compare `sha256=<hex>` to header with `crypto.timingSafeEqual`. Needs the RAW
  body — `onRequest` exposes `req.rawBody` (Buffer); use it, not the parsed JSON.
* repoId = `${owner}_${repo}` from `repository.owner.login` + `repository.name`.
* Triggers run without a user context; outbound GitHub calls (e.g. createIssue)
  must fetch the repo owner's token from `users/{uid}.githubAccessToken`.
