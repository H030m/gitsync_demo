// scheduledDailyReport — fan-out scheduler. Runs at 18:00 Taipei daily, scans
// every repo doc, and enqueues one Cloud Task per repo targeting
// `dailyReportWorker`. The scheduler returns immediately; the workers run in
// parallel (AGENTIC_CONCEPTS §5 isolated sub-agents). See ARCHITECTURE.md §5.4.
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { getFunctions } from 'firebase-admin/functions';

import { db, REGION } from '../admin';

// Fully-qualified Cloud Tasks target: the dailyReportWorker queue in our region.
// Using the resource path (not a bare name) pins the region so enqueue does not
// fall back to us-central1.
const WORKER_QUEUE = `locations/${REGION}/functions/dailyReportWorker`;

export const scheduledDailyReport = onSchedule(
  {
    schedule: '0 18 * * *',
    timeZone: 'Asia/Taipei',
    region: REGION,
  },
  async () => {
    const snap = await db.collection('apps/gitsync/repos').get();
    const ids = snap.docs.map((d) => d.id);
    const today = new Date().toISOString().slice(0, 10);
    logger.info(`scheduledDailyReport: fanning out ${ids.length} repos`, {
      date: today,
    });

    if (ids.length === 0) return;

    const queue = getFunctions().taskQueue(WORKER_QUEUE);
    // Enqueue independently — one repo failing to enqueue must not block the
    // rest. Settle all, then log how many made it.
    const outcomes = await Promise.allSettled(
      ids.map((repoId) => queue.enqueue({ repoId, date: today })),
    );

    const failed = outcomes.filter((o) => o.status === 'rejected');
    for (const f of failed) {
      logger.error('scheduledDailyReport: enqueue failed', {
        reason: String((f as PromiseRejectedResult).reason),
      });
    }
    logger.info('scheduledDailyReport: enqueued', {
      total: ids.length,
      enqueued: ids.length - failed.length,
      failed: failed.length,
      date: today,
    });
  },
);
