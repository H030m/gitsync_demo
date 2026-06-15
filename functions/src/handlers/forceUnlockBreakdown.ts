// forceUnlockBreakdown (callable) — manually clears a stuck `isBreakingDown`
// lock. The Flutter app exposes a "reset" button after the lock has been held
// for > 5 minutes. See ARCHITECTURE.md §5.1 "auto-unlock fallback".
import { onCall, HttpsError } from 'firebase-functions/v2/https';

import { db, REGION } from '../admin';

export const forceUnlockBreakdown = onCall(
  { region: REGION },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const { repoId } = request.data as { repoId?: string };
    if (!repoId) {
      throw new HttpsError('invalid-argument', 'repoId is required');
    }
    await db.doc(`apps/gitsync/repos/${repoId}`).update({
      isBreakingDown: false,
      breakdownStartedAt: null,
    });
    return { ok: true };
  },
);
