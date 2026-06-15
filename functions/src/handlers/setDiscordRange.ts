// setDiscordRange (callable, auth) — the app's Daily date picker binds the
// shared window to Discord through this. It:
//   1. persists the range on the repo doc (discordStartDate/discordEndDate) so
//      it survives re-login and pre-fills the picker,
//   2. resets each channel's watermark so the next backfill re-pulls the whole
//      new window (messageId dedup prevents duplicates).
//
// ADDITIVE-ONLY: this NO LONGER deletes anything. The earlier version pruned
// out-of-window discordMessages and discordDigests, which caused a data-loss
// incident (06-05) when the shared range got bound to Discord — narrowing the
// window silently wiped history. Deletion is removed: messageId dedup makes
// re-pulls safe, and AI reads are now time-scoped (discordChat range filter)
// instead of physically pruning storage. Binding the shared range here is safe.
// See ARCHITECTURE.md §7 and prd.md (06-05-one-date-one-refresh…).
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';

import { db, REGION } from '../admin';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const setDiscordRange = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('failed-precondition', 'Please log in first.');
  }

  const { repoId, startDate, endDate } = request.data as {
    repoId?: string;
    startDate?: string;
    endDate?: string;
  };
  if (!repoId || typeof repoId !== 'string') {
    throw new HttpsError('invalid-argument', 'repoId is required');
  }
  if (!startDate || !DATE_RE.test(startDate) || !endDate || !DATE_RE.test(endDate)) {
    throw new HttpsError('invalid-argument', 'startDate/endDate must be YYYY-MM-DD');
  }
  if (startDate > endDate) {
    throw new HttpsError('invalid-argument', 'startDate must be <= endDate');
  }

  const repoRef = db.doc(`apps/gitsync/repos/${repoId}`);
  const [repoSnap, chanSnap] = await Promise.all([
    repoRef.get(),
    repoRef.collection('discordChannels').get(),
  ]);
  if (!repoSnap.exists) {
    throw new HttpsError('not-found', `repo ${repoId} not found`);
  }

  // 1. Persist the range on the repo doc (source of truth for the picker + bot).
  await repoRef.set(
    {
      discordStartDate: startDate,
      discordEndDate: endDate,
      discordRangeSetAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  // 2. Reset each channel's watermark so the next backfill re-pulls the window.
  //    messageId dedup prevents duplicates; nothing is deleted (additive-only).
  const ids = new Set<string>([
    ...((repoSnap.data()?.discordChannelIds as string[] | undefined) ?? []),
    ...chanSnap.docs.map((d) => d.id),
  ]);
  if (ids.size > 0) {
    const batch = db.batch();
    for (const id of ids) {
      batch.set(
        repoRef.collection('discordChannels').doc(id),
        { startDate, lastMessageId: FieldValue.delete() },
        { merge: true },
      );
    }
    await batch.commit();
  }

  logger.info('setDiscordRange applied (additive-only, no prune)', {
    repoId,
    startDate,
    endDate,
    channelCount: ids.size,
  });

  return {
    ok: true,
    channelCount: ids.size,
  };
});
