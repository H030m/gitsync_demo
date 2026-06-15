import { onCall, HttpsError } from 'firebase-functions/v2/https';

import { REGION } from '../admin';
import { openaiKey } from '../config';
import { summarizeDayFlow } from '../flows/summarizeDay';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92; // mirrors the Discord backfill cap

/** Inclusive day count between two YYYY-MM-DD dates (assumes valid input). */
function rangeDays(start: string, end: string): number {
  const ms =
    new Date(`${end}T00:00:00Z`).getTime() -
    new Date(`${start}T00:00:00Z`).getTime();
  return ms / 86_400_000 + 1;
}

// summarizeDay — generates the Summary tab report. Accepts either the legacy
// single-day `{ repoId, date }` or a user-picked range
// `{ repoId, startDate, endDate }` (inclusive, Asia/Taipei days).
export const summarizeDay = onCall(
  { region: REGION, secrets: [openaiKey], timeoutSeconds: 180 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const { repoId, date, startDate, endDate, language } = request.data as {
      repoId?: string;
      date?: string;
      startDate?: string;
      endDate?: string;
      language?: string;
    };
    if (!repoId) {
      throw new HttpsError('invalid-argument', 'repoId is required');
    }
    // W6: optional language (a human-readable English language NAME the client
    // derives from the app locale) forces the regenerated narrative into that
    // language; absent → unchanged behavior (the scheduled report omits it).
    if (language !== undefined && typeof language !== 'string') {
      throw new HttpsError('invalid-argument', 'language must be a string');
    }

    // Normalize: `date` is shorthand for a one-day range.
    const start = startDate ?? date;
    const end = endDate ?? start;
    if (!start || !DATE_RE.test(start) || !end || !DATE_RE.test(end)) {
      throw new HttpsError(
        'invalid-argument',
        'date or startDate/endDate (YYYY-MM-DD) are required',
      );
    }
    if (end < start) {
      throw new HttpsError('invalid-argument', 'endDate must be >= startDate');
    }
    if (rangeDays(start, end) > MAX_RANGE_DAYS) {
      throw new HttpsError(
        'invalid-argument',
        `range too long (max ${MAX_RANGE_DAYS} days)`,
      );
    }

    return summarizeDayFlow({ repoId, startDate: start, endDate: end, language });
  },
);
