// onCommitCompletesTask — when a commit lands on the repo's DEFAULT branch and
// its message references an issue (`#N`), an AI agent judges whether the linked
// task is actually complete; if so (high confidence) the task is auto-marked
// `done`. The "commit version" of onPRMerged.
//
// Trigger type & guard (06-14 D4): uses onDocumentWritten (NOT onCommitCreated).
// A commit is usually first seen on a feature branch — onCommitCreated fires
// once there and is then locked by markIdempotent; the later merge-to-main
// re-push hits ALREADY_EXISTS on `.create()` so onCommitCreated never re-fires.
// Instead, handlePush does `set({ onDefaultBranch: true }, { merge: true })` for
// default-branch shas (a write even on a pre-existing doc), and this trigger
// guards on the transition `after.onDefaultBranch === true &&
// before?.onDefaultBranch !== true`.
//
// We parse `#N` ourselves (parseIssueRefs) rather than depending on the
// `linkedTaskIds` written by onCommitCreated, to avoid a race between the two
// triggers (06-14 D4).
//
// Best-effort: the judge and per-task work are wrapped so a single failure never
// throws out of the trigger; markTaskDone's in-txn re-read keeps it idempotent.
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';

import { db, REGION } from '../admin';
import { openaiKey } from '../config';
import { markIdempotent } from '../tools/idempotency';
import { parseIssueRefs } from '../tools/issueRefs';
import { judgeTaskCompletion } from '../tools/judgeTaskCompletion';
import { findTaskIdsByIssue, markTaskDone } from '../tools/taskStatus';

// Only auto-complete when the agent is at least this confident (06-14 D2).
const THRESHOLD = 0.8;

export const onCommitCompletesTask = onDocumentWritten(
  {
    document: 'apps/gitsync/repos/{repoId}/commits/{sha}',
    region: REGION,
    secrets: [openaiKey],
  },
  async (event) => {
    // The transition guard runs BEFORE markIdempotent — and that ordering is
    // load-bearing. `commits/{sha}` has TWO triggers: onCommitCreated
    // (onDocumentCreated) and this one (onDocumentWritten). The FIRST-SEEN
    // feature-branch `.create()` is a single write that fires BOTH, with the
    // SAME `event.id` (Rule D.1: event.id is shared across functions bound to
    // the same document write). If we called markIdempotent first, this trigger
    // could win the race, consume the shared key, and STARVE onCommitCreated of
    // its linking/embedding work. So we cheaply reject everything but the
    // default-branch transition (in-memory, no I/O) first; only the dedicated
    // `set({onDefaultBranch:true},{merge:true})` write in handlePush — a write
    // onCommitCreated does NOT observe — gets past here, so the two triggers
    // never contend for an event id.
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after) return; // deletion — nothing to do

    // Act ONLY on the transition into onDefaultBranch (06-14 D4): a default-branch
    // push flips the flag false→true. Anything else (feature-branch create,
    // enrichment update, re-fire where it was already true) is a no-op.
    if (after.onDefaultBranch !== true) return;
    if (before?.onDefaultBranch === true) return;

    const fresh = await markIdempotent(event.id);
    if (!fresh) return;

    const { repoId, sha } = event.params as { repoId: string; sha: string };
    const message = (after.message as string | undefined) ?? '';
    const refs = parseIssueRefs(message);
    if (refs.length === 0) {
      logger.info('onCommitCompletesTask: no issue refs', { repoId, sha });
      return;
    }

    const filesChanged = (after.filesChanged as string[] | undefined) ?? [];
    const commitCtx = { message, filesChanged };

    let marked = 0;
    for (const n of refs) {
      let taskIds: string[] = [];
      try {
        taskIds = await findTaskIdsByIssue(repoId, n);
      } catch (err) {
        logger.warn('onCommitCompletesTask: findTaskIdsByIssue failed', {
          repoId,
          sha,
          issue: n,
          err: String(err),
        });
        continue;
      }

      for (const taskId of taskIds) {
        try {
          const snap = await db
            .doc(`apps/gitsync/repos/${repoId}/tasks/${taskId}`)
            .get();
          if (!snap.exists) continue;
          const task = snap.data() ?? {};
          if (task.status === 'done') {
            // Already done — markTaskDone is idempotent anyway, but skip the
            // OpenAI call entirely (no point judging a completed task).
            continue;
          }

          const judgement = await judgeTaskCompletion(
            {
              title: (task.title as string | undefined) ?? '',
              description: (task.description as string | undefined) ?? '',
              acceptanceCriteria:
                (task.acceptanceCriteria as string[] | undefined) ?? [],
            },
            commitCtx,
          );

          if (judgement.complete && judgement.confidence >= THRESHOLD) {
            await markTaskDone(repoId, taskId);
            marked += 1;
            logger.info('onCommitCompletesTask: marked task done', {
              repoId,
              sha,
              taskId,
              issue: n,
              confidence: judgement.confidence,
              reason: judgement.reason,
            });
          } else {
            logger.info('onCommitCompletesTask: not completing task', {
              repoId,
              sha,
              taskId,
              issue: n,
              complete: judgement.complete,
              confidence: judgement.confidence,
              reason: judgement.reason,
            });
          }
        } catch (err) {
          // Best-effort per task: one failure must not abort the others.
          logger.warn('onCommitCompletesTask: task judgement failed', {
            repoId,
            sha,
            taskId,
            issue: n,
            err: String(err),
          });
        }
      }
    }

    logger.info('onCommitCompletesTask: done', { repoId, sha, marked });
  },
);
