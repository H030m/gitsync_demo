// setDiscordStartDate (callable, auth) — the app's Daily → Discord date picker
// calls this to set the backfill start date for ALL of a repo's bound channels.
// Writes `startDate` and clears each channel's watermark (`lastMessageId`) so the
// next backfill re-fetches from the new start; messageId dedup keeps it from
// duplicating already-ingested messages. See ARCHITECTURE.md §7.
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';

import { db, REGION } from '../admin';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const setDiscordStartDate = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('failed-precondition', 'Please log in first.');
  }

  const { repoId, startDate } = request.data as {
    repoId?: string;
    startDate?: string;
  };
  if (!repoId || typeof repoId !== 'string') {
    throw new HttpsError('invalid-argument', 'repoId is required');
  }
  if (!startDate || typeof startDate !== 'string' || !DATE_RE.test(startDate)) {
    throw new HttpsError('invalid-argument', 'startDate must be YYYY-MM-DD');
  }

  const repoRef = db.doc(`apps/gitsync/repos/${repoId}`);
  const [repoSnap, chanSnap] = await Promise.all([
    repoRef.get(),
    repoRef.collection('discordChannels').get(),
  ]);
  if (!repoSnap.exists) {
    throw new HttpsError('not-found', `repo ${repoId} not found`);
  }

  // Union of the legacy discordChannelIds array + the discordChannels subcollection.
  const ids = new Set<string>([
    ...((repoSnap.data()?.discordChannelIds as string[] | undefined) ?? []),
    ...chanSnap.docs.map((d) => d.id),
  ]);
  if (ids.size === 0) {
    throw new HttpsError(
      'failed-precondition',
      'no Discord channels bound to this repo yet (run /gitsync-listen first)',
    );
  }

  const batch = db.batch();
  for (const id of ids) {
    batch.set(
      repoRef.collection('discordChannels').doc(id),
      {
        startDate,
        lastMessageId: FieldValue.delete(),
        startDateSetAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
  await batch.commit();

  return { ok: true, channelCount: ids.size };
});
