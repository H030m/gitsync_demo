// onTaskDeleted — when a task is deleted in the app, close its mirrored GitHub
// issue. GitHub's REST API can't delete issues, so we close (state:'closed').
// Mirrors onTaskCreated (which opens the issue). Best-effort: a missing token /
// repo / issue, or a GitHub failure, just logs — the trigger never throws.
//
// No loop risk: closing the issue makes the webhook write `issues/{n}`, which
// fires onIssueWritten; but the task is already gone, so it finds no linked task
// and no-ops.
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';

import { db, REGION } from '../admin';
import { closeIssue } from '../services/githubClient';
import { markIdempotent } from '../tools/idempotency';

/** Splits the repo doc `name` ("owner/repo") into owner/repo (names may contain `_`). */
function ownerRepoFromName(name: unknown): { owner: string; repo: string } | null {
  if (typeof name !== 'string') return null;
  const idx = name.indexOf('/');
  if (idx <= 0 || idx === name.length - 1) return null;
  return { owner: name.slice(0, idx), repo: name.slice(idx + 1) };
}

export const onTaskDeleted = onDocumentDeleted(
  {
    document: 'apps/gitsync/repos/{repoId}/tasks/{taskId}',
    region: REGION,
  },
  async (event) => {
    const fresh = await markIdempotent(event.id);
    if (!fresh) return;

    const task = event.data?.data();
    if (!task) return;
    const issueNumber = task.githubIssueNumber as number | undefined;
    if (issueNumber == null) return; // task wasn't mirrored to an issue

    const { repoId, taskId } = event.params as {
      repoId: string;
      taskId: string;
    };

    const repoSnap = await db.doc(`apps/gitsync/repos/${repoId}`).get();
    const parsed = ownerRepoFromName(repoSnap.data()?.name);
    if (!parsed) return;

    const createdBy = task.createdBy as string | undefined;
    if (!createdBy) return;
    const userSnap = await db.doc(`apps/gitsync/users/${createdBy}`).get();
    const token = userSnap.data()?.githubAccessToken as string | undefined;
    if (!token) {
      logger.warn('onTaskDeleted: no GitHub token, skipping close', {
        repoId,
        taskId,
      });
      return;
    }

    try {
      await closeIssue(parsed.owner, parsed.repo, token, issueNumber);
      logger.info('onTaskDeleted: closed mirrored issue', {
        repoId,
        taskId,
        issueNumber,
      });
    } catch (err) {
      logger.warn('onTaskDeleted: closeIssue failed (best-effort)', {
        repoId,
        taskId,
        err: String(err),
      });
    }
  },
);
