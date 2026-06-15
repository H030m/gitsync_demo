// requestDiscordFetch (callable) — the Daily → Discord refresh button calls
// this to enqueue an on-demand backfill. Writes a `fetchRequests` doc that the
// always-on bot later claims via `claimDiscordFetch`. See ARCHITECTURE.md §7.
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';

import { db, REGION } from '../admin';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const requestDiscordFetch = onCall(
  { region: REGION },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const uid = request.auth.uid;

    const { repoId, date } = request.data as { repoId?: string; date?: string };
    if (!repoId || typeof repoId !== 'string') {
      throw new HttpsError('invalid-argument', 'repoId is required');
    }
    if (!date || typeof date !== 'string' || !DATE_RE.test(date)) {
      throw new HttpsError('invalid-argument', 'date must be YYYY-MM-DD');
    }

    const ref = await db
      .collection(`apps/gitsync/repos/${repoId}/fetchRequests`)
      .add({
        repoId,
        date,
        status: 'pending',
        requestedBy: uid,
        createdAt: FieldValue.serverTimestamp(),
      });

    return { requestId: ref.id };
  },
);
