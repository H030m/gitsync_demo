// backfillEmbeddings (onCall) — one-off, per-repo + per-collection backfill of
// embedding vectors for historical docs written before the embedding step
// existed (commits) / while it was a stub (discordMessages).
//
// Idempotent + batched: each call processes up to a few batches of ~50 docs
// within a soft time budget, then returns a cursor. Re-invoking with the
// returned `nextCursor` continues where it left off until `done: true`. A doc
// that already carries its embedding field is skipped; noise docs (per the same
// filters used on write) are skipped too. Per-repo + per-collection is enforced
// to bound storage cost (see prd Cost/Storage).
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';

import { db, REGION } from '../admin';
import { openaiKey } from '../config';
import { shouldSkipEmbedding } from '../tools/commitFilter';
import { shouldKeepMessage } from '../tools/discordFilter';
import { embedToFieldValue } from '../tools/embedding';

type BackfillCollection = 'commits' | 'discordMessages';

// Per-collection contract: the embedding field name, the content field to embed,
// and whether a given content should be skipped as noise (mirrors the on-write
// filters so the backfill stays consistent with live ingestion).
const SPECS: Record<
  BackfillCollection,
  {
    embeddingField: string;
    contentField: string;
    skip: (content: string) => boolean;
  }
> = {
  commits: {
    embeddingField: 'messageEmbedding',
    contentField: 'message',
    skip: (content) => shouldSkipEmbedding(content),
  },
  discordMessages: {
    embeddingField: 'embedding',
    contentField: 'content',
    skip: (content) => !shouldKeepMessage({ content }),
  },
};

const BATCH_SIZE = 50; // docs read per page (orderBy __name__ + startAfter)
const TIME_BUDGET_MS = 240_000; // soft budget; return a cursor when exceeded

interface BackfillStats {
  scanned: number;
  embedded: number;
  skippedExisting: number;
  skippedFiltered: number;
  failed: number;
}

export const backfillEmbeddings = onCall(
  { region: REGION, secrets: [openaiKey], timeoutSeconds: 300 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const { repoId, collection, cursor } = request.data as {
      repoId?: string;
      collection?: string;
      cursor?: string;
    };
    if (!repoId) {
      throw new HttpsError('invalid-argument', 'repoId is required');
    }
    if (collection !== 'commits' && collection !== 'discordMessages') {
      throw new HttpsError(
        'invalid-argument',
        "collection must be 'commits' or 'discordMessages'",
      );
    }

    const spec = SPECS[collection];
    const colRef = db.collection(`apps/gitsync/repos/${repoId}/${collection}`);
    const stats: BackfillStats = {
      scanned: 0,
      embedded: 0,
      skippedExisting: 0,
      skippedFiltered: 0,
      failed: 0,
    };

    const startedAt = Date.now();
    let last = typeof cursor === 'string' && cursor ? cursor : undefined;
    let done = false;

    // Page through docs by document id (__name__) so the cursor is a plain
    // string and re-invocation is deterministic.
    for (;;) {
      let q = colRef.orderBy('__name__').limit(BATCH_SIZE);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) {
        done = true;
        break;
      }

      for (const d of snap.docs) {
        stats.scanned++;
        last = d.id;
        const data = d.data() ?? {};

        if (data[spec.embeddingField] !== undefined) {
          stats.skippedExisting++; // already embedded → idempotent skip
          continue;
        }
        const content = (data[spec.contentField] as string | undefined) ?? '';
        if (!content || spec.skip(content)) {
          stats.skippedFiltered++;
          continue;
        }

        try {
          const vec = await embedToFieldValue(content);
          await d.ref.update({ [spec.embeddingField]: vec });
          stats.embedded++;
        } catch (err) {
          // Best-effort: one failure is counted and never aborts the batch.
          stats.failed++;
          logger.warn('backfillEmbeddings: embed failed (skipping doc)', {
            repoId,
            collection,
            docId: d.id,
            err: String(err),
          });
        }
      }

      // Fewer than a full page → reached the end of the collection.
      if (snap.size < BATCH_SIZE) {
        done = true;
        break;
      }
      // Out of time → stop and hand back a cursor for the next invocation.
      if (Date.now() - startedAt >= TIME_BUDGET_MS) break;
    }

    logger.info('backfillEmbeddings: pass complete', {
      repoId,
      collection,
      done,
      ...stats,
    });
    return done ? { done, stats } : { done, nextCursor: last, stats };
  },
);
