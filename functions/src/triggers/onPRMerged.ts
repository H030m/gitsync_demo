// onPRMerged — when a pullRequests doc enters state `merged`, parse the closing
// keywords (`closes/fixes/resolves #N`) out of the PR title + body, resolve the
// tasks mirrored by those issue numbers, and mark them done.
//
// Uses onDocumentWritten (not onDocumentUpdated): the webhook's `handlePR` only
// writes the pullRequests doc on `closed && merged`, so the doc is *created*
// already in state `merged`. onDocumentUpdated does NOT fire on creation, which
// would silently break the headline "merge PR → task done" flow. onDocumentWritten
// fires on create + update; we treat any transition INTO `merged` (incl. a fresh
// create where there is no before) as the trigger.
//
// The done-marking + assignee counter bump happen in a transaction whose
// in-txn status re-read is the idempotency guard against double-counting if the
// trigger fires more than once (Rule B + Rule D).
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';

import { REGION } from '../admin';
import { markIdempotent } from '../tools/idempotency';
import { parseClosingRefs, parseIssueRefs } from '../tools/issueRefs';
import { findTaskIdsByIssue, markTaskDone } from '../tools/taskStatus';

export const onPRMerged = onDocumentWritten(
  {
    document: 'apps/gitsync/repos/{repoId}/pullRequests/{prNumber}',
    region: REGION,
  },
  async (event) => {
    const fresh = await markIdempotent(event.id);
    if (!fresh) return;

    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after) return; // deletion — nothing to do
    // Act only on the transition INTO `merged`: a create lands here with no
    // `before` (state→merged), and an update only when it wasn't merged before.
    if (after.state !== 'merged') return;
    if (before?.state === 'merged') return;

    const { repoId } = event.params as { repoId: string };
    const title = (after.title as string | undefined) ?? '';
    const body = (after.body as string | undefined) ?? '';

    // Prefer explicit closing keywords; fall back to plain `#N` in the body so a
    // PR that merely references the issue still completes it.
    const text = `${title}\n${body}`;
    let issueNumbers = parseClosingRefs(text);
    if (issueNumbers.length === 0) {
      issueNumbers = parseIssueRefs(body);
    }
    if (issueNumbers.length === 0) {
      logger.info('onPRMerged: no closing refs found', { repoId });
      return;
    }

    let marked = 0;
    for (const n of issueNumbers) {
      const taskIds = await findTaskIdsByIssue(repoId, n);
      for (const taskId of taskIds) {
        await markTaskDone(repoId, taskId);
        marked += 1;
      }
    }
    logger.info('onPRMerged: marked linked tasks done', { repoId, issueNumbers, marked });
  },
);
