// onIssueWritten — reverse-syncs a GitHub issue's state into its mirrored task
// status. The webhook writes raw `issues/{n}` docs (state from GitHub); this
// trigger maps state transitions to task status:
//   - issue closed   → task done (same idempotent in-txn guard as onPRMerged)
//   - issue reopened  → task todo
// Only state TRANSITIONS act (open→closed / closed→open); other writes are
// no-ops. Idempotency guarded first (Rule C); task writes are transactional.
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';

import { REGION } from '../admin';
import { markIdempotent } from '../tools/idempotency';
import { findTaskIdsByIssue, markTaskDone, revertTaskToTodo } from '../tools/taskStatus';

export const onIssueWritten = onDocumentWritten(
  {
    document: 'apps/gitsync/repos/{repoId}/issues/{issueNumber}',
    region: REGION,
  },
  async (event) => {
    const fresh = await markIdempotent(event.id);
    if (!fresh) return;

    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after) return; // deletion — nothing to sync

    const { repoId, issueNumber } = event.params as {
      repoId: string;
      issueNumber: string;
    };
    const n = Number(issueNumber);
    if (!Number.isInteger(n)) return;

    const beforeState = before?.state as string | undefined;
    const afterState = after.state as string | undefined;

    let action: 'done' | 'todo' | null = null;
    if (afterState === 'closed' && beforeState !== 'closed') {
      action = 'done';
    } else if (afterState === 'open' && beforeState === 'closed') {
      action = 'todo';
    }
    if (!action) return;

    const taskIds = await findTaskIdsByIssue(repoId, n);
    if (taskIds.length === 0) {
      logger.info('onIssueWritten: no task mirrors this issue', { repoId, issueNumber });
      return;
    }
    for (const taskId of taskIds) {
      if (action === 'done') await markTaskDone(repoId, taskId);
      else await revertTaskToTodo(repoId, taskId);
    }
    logger.info('onIssueWritten: synced issue state to tasks', {
      repoId,
      issueNumber,
      action,
      count: taskIds.length,
    });
  },
);
