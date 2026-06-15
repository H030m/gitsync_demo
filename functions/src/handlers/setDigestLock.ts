import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';

import { db, REGION } from '../admin';

// setDigestLock (onCall) — freeze / unfreeze a Discord daily digest. When
// `locked` is true, no write path will change the digest: editDiscordDigestFlow
// refuses, and discordDailyDigestFlow skips regeneration. See ARCHITECTURE §7.
export const setDigestLock = onCall(
  { region: REGION },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const { repoId, date, locked } = request.data as {
      repoId?: string;
      date?: string;
      locked?: boolean;
    };
    if (!repoId || !date || typeof locked !== 'boolean') {
      throw new HttpsError(
        'invalid-argument',
        'repoId, date and a boolean locked are required',
      );
    }

    const ref = db.doc(`apps/gitsync/repos/${repoId}/discordDigests/${date}`);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError('not-found', `No digest for ${date} yet.`);
    }

    await ref.set(
      {
        locked,
        lockedAt: locked ? FieldValue.serverTimestamp() : null,
        lockedBy: locked ? request.auth.uid : null,
      },
      { merge: true },
    );
    return { date, locked };
  },
);
