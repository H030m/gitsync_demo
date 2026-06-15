// onCommitCreated — links a raw commit doc to tasks and enriches it.
//
// Steps (all heavy work runs AFTER the idempotency guard — Rule D):
//   1. Link: parse `#N` (incl. closing keywords) from the message, resolve
//      tasks by `githubIssueNumber`, write `linkedTaskIds`.
//   2. Embed: unless `shouldSkipEmbedding(message)`, compute the message
//      embedding and store it as `FieldValue.vector(...)`.
//   3. Summarize: a one-line `aiSummary` via gpt-4o-mini (best-effort).
// All results are written back to the commit doc in a single update.
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';

import { db, REGION } from '../admin';
import { getOpenAI, MODELS, openaiKey } from '../config';
import { shouldSkipEmbedding } from '../tools/commitFilter';
import { embedToFieldValue } from '../tools/embedding';
import { markIdempotent } from '../tools/idempotency';
import { parseIssueRefs } from '../tools/issueRefs';

export const onCommitCreated = onDocumentCreated(
  {
    document: 'apps/gitsync/repos/{repoId}/commits/{sha}',
    region: REGION,
    secrets: [openaiKey],
  },
  async (event) => {
    const fresh = await markIdempotent(event.id);
    if (!fresh) return;

    const commit = event.data?.data();
    if (!commit) return;

    const message = commit.message as string | undefined;
    if (!message) return;

    const { repoId, sha } = event.params as { repoId: string; sha: string };
    const update: Record<string, unknown> = {};

    // ---- 1. Link `#N` → task ids -------------------------------------------
    const refs = parseIssueRefs(message);
    const linkedTaskIds: string[] = [];
    for (const n of refs) {
      const snap = await db
        .collection(`apps/gitsync/repos/${repoId}/tasks`)
        .where('githubIssueNumber', '==', n)
        .get();
      for (const doc of snap.docs) linkedTaskIds.push(doc.id);
    }
    update.linkedTaskIds = linkedTaskIds;

    // ---- 2. Embedding (skip noise commits) ---------------------------------
    if (shouldSkipEmbedding(message)) {
      logger.info('Skipping commit embedding (filter hit)', { sha });
    } else {
      try {
        update.messageEmbedding = await embedToFieldValue(message);
      } catch (err) {
        // Best-effort: MVP accepts an occasional null embedding on failure.
        logger.warn('onCommitCreated: embedding failed (leaving null)', {
          repoId,
          sha,
          err: String(err),
        });
      }

      // ---- 3. One-line aiSummary -------------------------------------------
      try {
        const completion = await getOpenAI().chat.completions.create({
          model: MODELS.fast,
          messages: [
            {
              role: 'system',
              content:
                'Summarize the following git commit message in one short, plain ' +
                'sentence. Respond with the sentence only.',
            },
            { role: 'user', content: message },
          ],
        });
        const summary = completion.choices[0]?.message?.content?.trim();
        if (summary) update.aiSummary = summary;
      } catch (err) {
        // Best-effort: leave aiSummary unset on failure.
        logger.warn('onCommitCreated: aiSummary failed (leaving unset)', {
          repoId,
          sha,
          err: String(err),
        });
      }
    }

    await db.doc(`apps/gitsync/repos/${repoId}/commits/${sha}`).update(update);
    logger.info('onCommitCreated: enriched commit', {
      repoId,
      sha,
      linked: linkedTaskIds.length,
    });
  },
);
