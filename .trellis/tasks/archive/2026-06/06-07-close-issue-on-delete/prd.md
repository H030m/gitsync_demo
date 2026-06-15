# Close the linked GitHub issue when a task is deleted

## Goal
Deleting a task in the app leaves its mirrored GitHub issue open. Close that
issue automatically on delete.

## Constraint (why "close", not "delete")
The GitHub REST API can't delete issues — only close them (`state: 'closed'`).
(GraphQL `deleteIssue` exists but needs repo-admin and is irreversible — out of
scope for an automatic flow.) So on task delete we CLOSE the issue.

## What I already know
* Task delete is a client Firestore delete (`TaskRepository.deleteTask`); no
  backend hook fires today. Mirror onTaskCreated's pattern with a NEW
  `onDocumentDeleted` trigger.
* The deleted doc carries `githubIssueNumber` + `createdBy`; repo `name` →
  owner/repo; creator's `users/{uid}.githubAccessToken` is the GitHub token
  (same as onTaskCreated / assignee-sync).
* All GitHub calls live in `services/githubClient.ts`.

## Requirements
1. `githubClient.closeIssue(owner, repo, accessToken, issueNumber)`.
2. New trigger `onTaskDeleted` (`onDocumentDeleted` on tasks): if the deleted
   task had a `githubIssueNumber`, resolve owner/repo + creator token and close
   the issue. Best-effort (Rule D) + idempotent; export in index.ts.
3. No loop: closing → webhook `issues` doc → `onIssueWritten` finds no linked
   task (it's deleted) → no-op.

## Acceptance Criteria
* [ ] Deleting a task with a linked issue closes that issue (live).
* [ ] No issue / no token → no-op, no throw. tsc + tests green.

## Out of Scope
* True hard-delete via GraphQL (needs admin); deleting commits/PRs.
