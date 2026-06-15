// completeDiscordFetch (onRequest, secret-auth) — the bot calls this after it
// has POSTed the day's backfilled messages to discordMessageIngest. Marks the
// fetch request `ingested`, then runs the AI daily-digest flow; on success
// marks `done`, on digest failure marks `digest_failed` (never crashes — the
// ingest itself already succeeded). Mirrors discordMessageIngest's secret auth.
// See ARCHITECTURE.md §7.
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';

import { db, REGION } from '../admin';
import { discordIngestSecret, openaiKey } from '../config';
import { discordDailyDigestFlow } from '../flows/discordDailyDigest';
import { discordRangeDigestFlow } from '../flows/discordRangeDigest';

export const completeDiscordFetch = onRequest(
  { region: REGION, secrets: [discordIngestSecret, openaiKey], maxInstances: 10 },
  async (req, res) => {
    if (req.header('x-ingest-secret') !== discordIngestSecret.value()) {
      res.status(401).send({ error: 'bad secret' });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).send({ error: 'method not allowed' });
      return;
    }

    const body = (req.body ?? {}) as {
      repoId?: string;
      requestId?: string;
      ingestedCount?: number;
      watermarks?: Array<{ channelId?: string; lastMessageId?: string }>;
    };
    const { repoId, requestId } = body;
    if (!repoId || typeof repoId !== 'string') {
      res.status(400).send({ error: 'repoId is required' });
      return;
    }
    if (!requestId || typeof requestId !== 'string') {
      res.status(400).send({ error: 'requestId is required' });
      return;
    }
    const ingestedCount =
      typeof body.ingestedCount === 'number' ? body.ingestedCount : 0;

    const reqRef = db.doc(
      `apps/gitsync/repos/${repoId}/fetchRequests/${requestId}`,
    );
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) {
      res.status(404).send({ error: 'fetch request not found' });
      return;
    }
    const date = reqSnap.data()?.date as string | undefined;
    if (!date) {
      res.status(400).send({ error: 'fetch request has no date' });
      return;
    }

    // 1. Mark the request `ingested` (the backfill itself is done).
    await reqRef.update({
      status: 'ingested',
      ingestedCount,
      ingestedAt: FieldValue.serverTimestamp(),
    });

    // 1b. Advance each channel's watermark to the newest message the bot saw,
    //     so the next backfill only fetches messages after it.
    const watermarks = Array.isArray(body.watermarks) ? body.watermarks : [];
    if (watermarks.length > 0) {
      const batch = db.batch();
      for (const w of watermarks) {
        if (w && typeof w.channelId === 'string' && typeof w.lastMessageId === 'string') {
          batch.set(
            db.doc(`apps/gitsync/repos/${repoId}/discordChannels/${w.channelId}`),
            { lastMessageId: w.lastMessageId, lastFetchedAt: FieldValue.serverTimestamp() },
            { merge: true },
          );
        }
      }
      await batch.commit();
    }

    // 2. Run the digest flow(s). A digest failure must not crash the request —
    //    the messages are already ingested, so flag it and let the user retry.
    //    When the repo has a backfill range, generate a digest for EACH day in
    //    it (so the chat agent's per-day summaries cover the whole window);
    //    otherwise fall back to a single digest for the request day.
    const repoSnap = await db.doc(`apps/gitsync/repos/${repoId}`).get();
    const startDate = repoSnap.data()?.discordStartDate as string | undefined;
    const endDate = repoSnap.data()?.discordEndDate as string | undefined;
    try {
      let summary: Record<string, unknown>;
      if (startDate && endDate) {
        const r = await discordRangeDigestFlow(repoId, startDate, endDate);
        summary = { rangeDigests: r };
      } else {
        const digest = await discordDailyDigestFlow({ repoId, date });
        summary = { messageCount: digest.messageCount };
      }
      await reqRef.update({
        status: 'done',
        completedAt: FieldValue.serverTimestamp(),
      });
      logger.info('completeDiscordFetch done', {
        repoId,
        requestId,
        date,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
        ...summary,
      });
      res.status(200).send({ ok: true, ...summary });
    } catch (e) {
      logger.error('discordDailyDigestFlow failed', {
        repoId,
        requestId,
        date,
        error: String(e),
      });
      await reqRef
        .update({
          status: 'digest_failed',
          completedAt: FieldValue.serverTimestamp(),
        })
        .catch(() => {});
      res.status(200).send({ ok: true, digestFailed: true });
    }
  },
);
