// claimDiscordFetch (onRequest, secret-auth) — the always-on bot polls this to
// claim the oldest pending fetch request. Atomically flips it to `claimed` and
// returns the repo's Discord channel ids so the bot can REST-backfill the day.
// Mirrors discordMessageIngest's shared-secret auth. See ARCHITECTURE.md §7.
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';

import { db, REGION } from '../admin';
import { discordIngestSecret } from '../config';

export const claimDiscordFetch = onRequest(
  { region: REGION, secrets: [discordIngestSecret], maxInstances: 10 },
  async (req, res) => {
    if (req.header('x-ingest-secret') !== discordIngestSecret.value()) {
      res.status(401).send({ error: 'bad secret' });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).send({ error: 'method not allowed' });
      return;
    }

    // Optional repo filter; otherwise scan all repos via a collectionGroup.
    const body = (req.body ?? {}) as { repoId?: string };
    const repoId = typeof body.repoId === 'string' ? body.repoId : undefined;

    // 1. Find the oldest pending request (outside the transaction; the txn
    //    re-reads and guards the status to avoid a double-claim race).
    const baseQuery = repoId
      ? db.collection(`apps/gitsync/repos/${repoId}/fetchRequests`)
      : db.collectionGroup('fetchRequests');
    const pendingSnap = await baseQuery
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'asc')
      .limit(1)
      .get();

    if (pendingSnap.empty) {
      res.status(200).send({ none: true });
      return;
    }

    const reqRef = pendingSnap.docs[0].ref;

    // 2. Claim it in a transaction (guard against a concurrent poller).
    const claimed = await db.runTransaction(async (txn) => {
      const fresh = await txn.get(reqRef);
      const data = fresh.data();
      if (!fresh.exists || !data || data.status !== 'pending') {
        return null; // someone else claimed it first
      }
      txn.update(reqRef, {
        status: 'claimed',
        claimedAt: FieldValue.serverTimestamp(),
      });
      return { requestId: fresh.id, repoId: data.repoId as string, date: data.date as string };
    });

    if (!claimed) {
      // Lost the race — tell the bot to poll again.
      res.status(200).send({ none: true });
      return;
    }

    // 3. Resolve the repo's channels + per-channel backfill state. The
    //    discordChannels subcollection is the source of truth for startDate /
    //    watermark; fall back to the legacy discordChannelIds array for
    //    channels bound before per-channel config existed.
    const repoRef = db.doc(`apps/gitsync/repos/${claimed.repoId}`);
    const [repoSnap, chanSnap] = await Promise.all([
      repoRef.get(),
      repoRef.collection('discordChannels').get(),
    ]);
    const legacyIds =
      (repoSnap.data()?.discordChannelIds as string[] | undefined) ?? [];

    const byId = new Map<
      string,
      { channelId: string; startDate: string | null; lastMessageId: string | null }
    >();
    for (const id of legacyIds) {
      byId.set(id, { channelId: id, startDate: null, lastMessageId: null });
    }
    for (const doc of chanSnap.docs) {
      const d = doc.data();
      byId.set(doc.id, {
        channelId: doc.id,
        startDate: (d.startDate as string | undefined) ?? null,
        lastMessageId: (d.lastMessageId as string | undefined) ?? null,
      });
    }
    const channels = [...byId.values()];

    // Repo-level backfill range (set via setDiscordRange). The bot derives the
    // low/high snowflake cursors from these; null falls back to per-channel
    // startDate / the request day.
    const repoData = repoSnap.data() ?? {};
    const startDate = (repoData.discordStartDate as string | undefined) ?? null;
    const endDate = (repoData.discordEndDate as string | undefined) ?? null;

    logger.info('claimDiscordFetch claimed request', {
      requestId: claimed.requestId,
      repoId: claimed.repoId,
      date: claimed.date,
      channelCount: channels.length,
      startDate,
      endDate,
    });
    res.status(200).send({
      requestId: claimed.requestId,
      repoId: claimed.repoId,
      date: claimed.date,
      startDate,
      endDate,
      channels,
      channelIds: channels.map((c) => c.channelId), // legacy field
    });
  },
);
