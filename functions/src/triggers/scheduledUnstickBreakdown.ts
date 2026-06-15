// scheduledUnstickBreakdown — fallback to release a stuck `isBreakingDown`
// flag (e.g. when the breakdownTask handler crashed before reaching `finally`).
// Runs every 10 minutes. See ARCHITECTURE.md §5.1.
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';

import { db, REGION } from '../admin';

export const scheduledUnstickBreakdown = onSchedule(
  { schedule: 'every 10 minutes', region: REGION },
  async () => {
    const fiveMinAgo = Timestamp.fromDate(new Date(Date.now() - 5 * 60 * 1000));
    const stuck = await db
      .collection('apps/gitsync/repos')
      .where('isBreakingDown', '==', true)
      .where('breakdownStartedAt', '<', fiveMinAgo)
      .get();

    if (stuck.empty) return;

    const batch = db.batch();
    for (const doc of stuck.docs) {
      batch.update(doc.ref, {
        isBreakingDown: false,
        breakdownStartedAt: null,
      });
    }
    await batch.commit();
    logger.warn(`Force-unlocked ${stuck.size} stuck breakdown(s)`);
  },
);
