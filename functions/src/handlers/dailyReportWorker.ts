// dailyReportWorker — Cloud Tasks queue worker. Each dispatch processes exactly
// one repo's daily report, fanned out from `scheduledDailyReport`. This is the
// "isolated sub-agent" pattern from AGENTIC_CONCEPTS §5: every instance knows
// only its own { repoId, date } and writes its result back to Firestore
// independently, so 50 repos run in parallel instead of one 540s for-loop.
//
// Uses `onTaskDispatched` (Cloud Tasks) rather than a raw HTTP endpoint, so the
// Firebase Admin SDK can enqueue with automatic auth + retry and the queue is
// provisioned with the function (no manual `gcloud tasks queues create`).
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { logger } from 'firebase-functions/v2';

import { REGION } from '../admin';
import { openaiKey } from '../config';
import { summarizeDayFlow } from '../flows/summarizeDay';

export const dailyReportWorker = onTaskDispatched(
  {
    region: REGION,
    secrets: [openaiKey],
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 30 },
    rateLimits: { maxConcurrentDispatches: 10 },
  },
  async (req) => {
    const { repoId, date } = (req.data ?? {}) as {
      repoId?: string;
      date?: string;
    };
    if (!repoId || !date) {
      // Bad task payload — log and ack (returning) so Cloud Tasks does not retry
      // a permanently-malformed task forever.
      logger.error('dailyReportWorker: missing repoId/date; dropping task', {
        repoId,
        date,
      });
      return;
    }
    // Throwing here makes Cloud Tasks retry per retryConfig (transient failures
    // like a flaky OpenAI call get a second chance). The scheduler always fans
    // out single days: startDate == endDate == date.
    await summarizeDayFlow({ repoId, startDate: date, endDate: date });
    logger.info('dailyReportWorker: report done', { repoId, date });
  },
);
