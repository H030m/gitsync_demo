// onTaskUpdated — when a task transitions to `done`, auto-assign now-ready
// downstream tasks (reusing assignTaskFlow) and FCM-notify each newly-ready
// downstream task's assignee. See prd.md (06-02-auto-assign-on-done) and
// ARCHITECTURE.md §4.3 (TODO a/b).
//
// Why onDocumentUpdated (not onDocumentWritten): tasks are CREATED `todo` and
// only later UPDATED to `done`, so the terminal-state transition is a genuine
// update (contrast onPRMerged, where handlePR creates the doc already merged —
// database-guidelines Rule E).
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';

import { REGION, db } from '../admin';
import { openaiKey } from '../config';
import { assignTaskFlow } from '../flows/assignTask';
import { generateHandoffFlow } from '../flows/generateHandoff';
import { setIssueAssignees } from '../services/githubClient';
import { markIdempotent } from '../tools/idempotency';
import { notifyAssignee } from '../tools/notify';
import { notifyMessages } from '../tools/i18n';

export const onTaskUpdated = onDocumentUpdated(
  {
    document: 'apps/gitsync/repos/{repoId}/tasks/{taskId}',
    region: REGION,
    // assignTaskFlow calls OpenAI → needs the key + a longer budget for several
    // downstream agentic loops.
    secrets: [openaiKey],
    timeoutSeconds: 300,
  },
  async (event) => {
    const fresh = await markIdempotent(event.id);
    if (!fresh) return;

    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;

    const { repoId, taskId } = event.params as {
      repoId: string;
      taskId: string;
    };

    // Assignee → GitHub issue sync. Runs on EVERY update (independent of the
    // done-transition below) so that a manual reassignment, or assignTaskFlow's
    // auto-assignment of a downstream task, mirrors to the linked issue.
    // Best-effort: a GitHub failure must never break the trigger.
    try {
      await syncIssueAssignee(repoId, taskId, before, after);
    } catch (e) {
      logger.warn('onTaskUpdated: issue assignee sync failed (best-effort)', {
        repoId,
        taskId,
        error: String(e),
      });
    }

    // Transition guard: only act on the FIRST transition into `done`. This also
    // prevents recursion — when assignTaskFlow writes a downstream task's
    // assigneeId this trigger re-fires, but that task's status didn't transition
    // to done, so we return here.
    if (before.status === 'done' || after.status !== 'done') return;

    const completedTaskId = taskId;
    logger.info('onTaskUpdated: task done, processing downstream', {
      repoId,
      completedTaskId,
    });

    // Downstream tasks: those whose dependsOn array-contains the completed task.
    // Single array-contains → Firestore auto-indexes (no composite needed).
    const downstreamSnap = await db
      .collection(`apps/gitsync/repos/${repoId}/tasks`)
      .where('dependsOn', 'array-contains', completedTaskId)
      .get();

    for (const doc of downstreamSnap.docs) {
      // Best-effort per downstream task: one failure must not abort the rest,
      // and the trigger must never throw (avoids at-least-once retry storms).
      try {
        const b = doc.data() ?? {};
        const dependsOn = (b.dependsOn as string[] | undefined) ?? [];

        // Ready filter: every prerequisite of B must be `done`. The completed
        // task A is one of them; confirm all the others too.
        const ready = await allPrereqsDone(repoId, dependsOn, completedTaskId);
        if (!ready) {
          logger.info('onTaskUpdated: downstream not ready, skipping', {
            repoId,
            downstreamId: doc.id,
          });
          continue;
        }

        // Assign if unassigned (reuse assignTaskFlow — it writes assigneeId and
        // balances counters via applyAssignment). Never overwrite a manual
        // assignment / call OpenAI when already assigned.
        let assigneeId = b.assigneeId as string | undefined;
        if (!assigneeId) {
          const result = await assignTaskFlow({ repoId, taskId: doc.id });
          assigneeId = result.assigneeId;
        }

        // Generate the AI handoff doc for this now-ready task from the real
        // commits + Discord behind its finished prerequisites. Best-effort:
        // force=false (skip if one already exists) and a failure must not block
        // the assignment/notify path.
        try {
          await generateHandoffFlow({ repoId, taskId: doc.id, force: false });
        } catch (e) {
          logger.warn('onTaskUpdated: handoff generation failed (best-effort)', {
            repoId,
            downstreamId: doc.id,
            error: String(e),
          });
        }

        // Notify the (new or existing) assignee that B is now unblocked. The
        // data payload lets the client deep-link straight to this task on tap.
        if (assigneeId) {
          await notifyAssignee(
            assigneeId,
            (locale) => ({
              title: notifyMessages.taskReadyTitle(locale),
              body: String(b.title ?? doc.id),
            }),
            { type: 'task_ready', repoId, taskId: doc.id },
          );
        }
      } catch (e) {
        logger.error('onTaskUpdated: downstream processing failed', {
          repoId,
          downstreamId: doc.id,
          error: String(e),
        });
      }
    }
  },
);

/**
 * Splits the repo doc `name` (`"${owner}/${repo}"`) into owner/repo. Uses the
 * stored `name` rather than splitting `repoId` on `_` because repo names can
 * contain `_` (same rule as onTaskCreated). Returns null when the shape is off.
 */
function ownerRepoFromName(
  name: unknown,
): { owner: string; repo: string } | null {
  if (typeof name !== 'string') return null;
  const idx = name.indexOf('/');
  if (idx <= 0 || idx === name.length - 1) return null;
  return { owner: name.slice(0, idx), repo: name.slice(idx + 1) };
}

/**
 * Mirror a task's in-app assignee onto its linked GitHub issue. No-op unless the
 * assignee actually changed and the task has a `githubIssueNumber`. Uses the task
 * creator's GitHub token (mirrors onTaskCreated) and the assignee's
 * `users/{uid}.githubLogin`; clearing the assignee clears the issue's assignees.
 * Best-effort — every missing precondition just returns (the caller swallows
 * throws from the GitHub call).
 */
async function syncIssueAssignee(
  repoId: string,
  taskId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Promise<void> {
  const beforeAssignee = (before.assigneeId as string | undefined) ?? '';
  const afterAssignee = (after.assigneeId as string | undefined) ?? '';
  if (beforeAssignee === afterAssignee) return; // assignee unchanged

  const issueNumber = after.githubIssueNumber as number | undefined;
  if (issueNumber == null) return; // task isn't mirrored to an issue

  const repoSnap = await db.doc(`apps/gitsync/repos/${repoId}`).get();
  const parsed = ownerRepoFromName(repoSnap.data()?.name);
  if (!parsed) return;

  const createdBy = after.createdBy as string | undefined;
  if (!createdBy) return;
  const creatorSnap = await db.doc(`apps/gitsync/users/${createdBy}`).get();
  const token = creatorSnap.data()?.githubAccessToken as string | undefined;
  if (!token) return;

  // Resolve the new assignee → GitHub login. Empty (unassigned) clears it.
  let assignees: string[] = [];
  if (afterAssignee) {
    const userSnap = await db.doc(`apps/gitsync/users/${afterAssignee}`).get();
    const login = userSnap.data()?.githubLogin as string | undefined;
    if (!login) return; // can't map this user to a GitHub account → skip
    assignees = [login];
  }

  await setIssueAssignees(parsed.owner, parsed.repo, token, issueNumber, assignees);
  logger.info('onTaskUpdated: synced issue assignee', {
    repoId,
    taskId,
    issueNumber,
    assignees,
  });
}

/**
 * True iff every prerequisite task id has `status === 'done'`. `completedId` is
 * known-done (it just transitioned), so we skip re-reading it.
 */
async function allPrereqsDone(
  repoId: string,
  dependsOn: string[],
  completedId: string,
): Promise<boolean> {
  for (const prereqId of dependsOn) {
    if (prereqId === completedId) continue;
    const snap = await db
      .doc(`apps/gitsync/repos/${repoId}/tasks/${prereqId}`)
      .get();
    if ((snap.data() ?? {}).status !== 'done') return false;
  }
  return true;
}
