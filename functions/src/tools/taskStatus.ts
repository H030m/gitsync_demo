// Transactional task status changes shared by onPRMerged + onIssueWritten.
//
// The in-transaction status RE-READ is the idempotency guard: if the trigger
// fires twice we never double-count the assignee's completedTaskCount (Rule B).
import { FieldValue } from 'firebase-admin/firestore';

import { db } from '../admin';

/**
 * Resolve the task doc ids in `repos/{repoId}/tasks` whose `githubIssueNumber`
 * equals `issueNumber`. Usually 0 or 1 (issue↔task is 1:1), but we return all.
 */
export async function findTaskIdsByIssue(
  repoId: string,
  issueNumber: number,
): Promise<string[]> {
  const snap = await db
    .collection(`apps/gitsync/repos/${repoId}/tasks`)
    .where('githubIssueNumber', '==', issueNumber)
    .get();
  return snap.docs.map((d) => d.id);
}

/**
 * Mark a task `done` exactly once. Re-reads inside the transaction; if the task
 * is already `done` it is a no-op (idempotent). On the first transition to
 * `done` it bumps `members/{assigneeId}.completedTaskCount` by +1 and
 * decrements `activeIssueCount` by -1 (both fields exist on the member shape
 * written by addRepo).
 */
export async function markTaskDone(repoId: string, taskId: string): Promise<void> {
  const taskRef = db.doc(`apps/gitsync/repos/${repoId}/tasks/${taskId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists) return;
    const task = snap.data() ?? {};
    if (task.status === 'done') return; // already counted → idempotent no-op

    tx.update(taskRef, { status: 'done', updatedAt: FieldValue.serverTimestamp() });

    const assigneeId = task.assigneeId as string | undefined;
    if (assigneeId) {
      const memberRef = db.doc(`apps/gitsync/repos/${repoId}/members/${assigneeId}`);
      tx.update(memberRef, {
        completedTaskCount: FieldValue.increment(1),
        activeIssueCount: FieldValue.increment(-1),
      });
    }
  });
}

/**
 * Assign (or reassign) a task to `assigneeId` and keep member workload counters
 * balanced, atomically (Rule A: `FieldValue.increment`; Rule B: cross-doc in a
 * single `runTransaction`). Re-reads the task inside the transaction to compute
 * the delta against the CURRENT assignee:
 *   - same assignee  → no counter change (idempotent re-assign).
 *   - new assignee    → new `activeIssueCount` +1.
 *   - reassign        → old assignee -1, new assignee +1.
 * Used by assignTaskFlow's finalizeAssignment (and its single-member / fallback
 * shortcuts), which all funnel through here.
 */
export async function applyAssignment(
  repoId: string,
  taskId: string,
  assigneeId: string,
): Promise<void> {
  const taskRef = db.doc(`apps/gitsync/repos/${repoId}/tasks/${taskId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists) return;
    const prevAssignee = (snap.data() ?? {}).assigneeId as string | undefined;
    if (prevAssignee === assigneeId) return; // already assigned → no-op

    tx.update(taskRef, {
      assigneeId,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const newMemberRef = db.doc(
      `apps/gitsync/repos/${repoId}/members/${assigneeId}`,
    );
    tx.update(newMemberRef, { activeIssueCount: FieldValue.increment(1) });

    if (prevAssignee) {
      const oldMemberRef = db.doc(
        `apps/gitsync/repos/${repoId}/members/${prevAssignee}`,
      );
      tx.update(oldMemberRef, { activeIssueCount: FieldValue.increment(-1) });
    }
  });
}

/**
 * Revert a task to `todo` (used when its mirror issue is reopened). Re-reads
 * inside the transaction; only reverts a task currently `done`, and reverses
 * the assignee counters set by {@link markTaskDone}.
 */
export async function revertTaskToTodo(repoId: string, taskId: string): Promise<void> {
  const taskRef = db.doc(`apps/gitsync/repos/${repoId}/tasks/${taskId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists) return;
    const task = snap.data() ?? {};
    if (task.status !== 'done') return; // only un-complete a completed task

    tx.update(taskRef, { status: 'todo', updatedAt: FieldValue.serverTimestamp() });

    const assigneeId = task.assigneeId as string | undefined;
    if (assigneeId) {
      const memberRef = db.doc(`apps/gitsync/repos/${repoId}/members/${assigneeId}`);
      tx.update(memberRef, {
        completedTaskCount: FieldValue.increment(-1),
        activeIssueCount: FieldValue.increment(1),
      });
    }
  });
}
