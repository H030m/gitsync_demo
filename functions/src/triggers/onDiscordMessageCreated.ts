import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';

import { db, REGION } from '../admin';
import { openaiKey } from '../config';
import { shouldKeepMessage } from '../tools/discordFilter';
import { embedToFieldValue } from '../tools/embedding';
import { markIdempotent } from '../tools/idempotency';

export const onDiscordMessageCreated = onDocumentCreated(
  {
    document: 'apps/gitsync/repos/{repoId}/discordMessages/{messageId}',
    region: REGION,
    secrets: [openaiKey],
  },
  async (event) => {
    const fresh = await markIdempotent(event.id);
    if (!fresh) return;

    const msg = event.data?.data();
    if (!msg) return;

    // Re-run the noise filter in case the forwarder rules drifted.
    if (!shouldKeepMessage({ content: msg.content as string })) {
      logger.info('Filtering Discord message (server-side noise check)');
      // We DON'T delete the doc — just skip embedding / linking work.
      return;
    }

    const content = msg.content as string | undefined;
    if (!content) return;

    const { repoId, messageId } = event.params as {
      repoId: string;
      messageId: string;
    };

    // ---- Embedding (heavy work runs AFTER the idempotency guard — Rule D) ---
    // Stored under `embedding` (the field name searchDiscordMessages and the
    // COLLECTION_GROUP vector index prefilter on — schema/index contract).
    const update: Record<string, unknown> = {};
    try {
      update.embedding = await embedToFieldValue(content);
    } catch (err) {
      // Best-effort: MVP accepts an occasional null embedding on failure.
      logger.warn('onDiscordMessageCreated: embedding failed (leaving null)', {
        repoId,
        messageId,
        err: String(err),
      });
    }

    if (Object.keys(update).length === 0) return; // nothing to persist
    await db
      .doc(`apps/gitsync/repos/${repoId}/discordMessages/${messageId}`)
      .update(update);
  },
);
