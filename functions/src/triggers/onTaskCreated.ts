// onTaskCreated — mirrors a newly created task as a GitHub issue so commits /
// PRs can reference it via `#N` (Q1 of task 06-02-github-webhook). Best-effort:
// if the owner token or repo info is missing, or the GitHub call fails, we log
// and leave `githubIssueNumber` null (a later backfill can retry) rather than
// crashing the trigger.
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';

import { db, REGION } from '../admin';
import { createIssue } from '../services/githubClient';
import { markIdempotent } from '../tools/idempotency';

/**
 * Splits the repo doc `name` (`"${owner}/${repo}"`) into owner/repo. We use the
 * stored `name` rather than splitting `repoId` on `_` because repo names can
 * themselves contain `_`. Returns null when the shape is unexpected.
 */
function ownerRepoFromName(name: unknown): { owner: string; repo: string } | null {
  if (typeof name !== 'string') return null;
  const idx = name.indexOf('/');
  if (idx <= 0 || idx === name.length - 1) return null;
  return { owner: name.slice(0, idx), repo: name.slice(idx + 1) };
}

export const onTaskCreated = onDocumentCreated(
  {
    document: 'apps/gitsync/repos/{repoId}/tasks/{taskId}',
    region: REGION,
  },
  async (event) => {
    const fresh = await markIdempotent(event.id);
    if (!fresh) return;

    const { repoId, taskId } = event.params as { repoId: string; taskId: string };
    const task = event.data?.data();
    if (!task) return;

    // Idempotency guard against duplicate issues: if the task already mirrors an
    // issue, do nothing.
    if (task.githubIssueNumber != null) {
      logger.info('onTaskCreated: task already mirrored, skipping', { repoId, taskId });
      return;
    }

    const repoSnap = await db.doc(`apps/gitsync/repos/${repoId}`).get();
    const parsed = ownerRepoFromName(repoSnap.data()?.name);
    if (!parsed) {
      logger.warn('onTaskCreated: cannot resolve owner/repo, skipping', { repoId, taskId });
      return;
    }

    const createdBy = task.createdBy as string | undefined;
    if (!createdBy) {
      logger.warn('onTaskCreated: task has no createdBy, skipping', { repoId, taskId });
      return;
    }
    const userSnap = await db.doc(`apps/gitsync/users/${createdBy}`).get();
    const token = userSnap.data()?.githubAccessToken as string | undefined;
    if (!token) {
      logger.warn('onTaskCreated: no GitHub token for creator, skipping (backfill later)', {
        repoId,
        taskId,
      });
      return;
    }

    const title = (task.title as string | undefined) ?? '';
    const description = (task.description as string | undefined) ?? '';
    const body =
      `${description}\n\n---\n_Mirrored from GitSync task \`${taskId}\`._`;

    try {
      const { number } = await createIssue(parsed.owner, parsed.repo, token, {
        title,
        body,
      });
      await db.doc(`apps/gitsync/repos/${repoId}/tasks/${taskId}`).update({
        githubIssueNumber: number,
      });
      logger.info('onTaskCreated: mirrored task as issue', { repoId, taskId, number });
    } catch (err) {
      // Best-effort: leave githubIssueNumber null so a later backfill can retry.
      logger.warn('onTaskCreated: createIssue failed (best-effort, leaving null)', {
        repoId,
        taskId,
        err: String(err),
      });
    }
  },
);
