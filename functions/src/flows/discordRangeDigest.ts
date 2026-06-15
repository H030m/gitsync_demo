// discordRangeDigestFlow — generates a per-DAY digest for every day in a
// backfill range [startDate, endDate], so the discord-chat agent's cheap path
// (listDaySummaries / getDaySummary) has a summary for each day instead of only
// the request day. Invoked by `completeDiscordFetch` after a range backfill.
//
// Efficiency guards (so we don't re-summarize the whole range on every refresh):
//   - empty days  → skipped (no digest doc, no OpenAI call)
//   - locked days → skipped (the user pinned that digest)
//   - unchanged   → skipped when the stored digest's messageCount already equals
//                   the day's current message count (a cheap count() aggregation,
//                   no OpenAI call)
// See ARCHITECTURE.md §7 and prd.md (06-03-discord-range-cursor).
import { logger } from 'firebase-functions/v2';

import { db } from '../admin';
import { discordDailyDigestFlow, taipeiDayBounds } from './discordDailyDigest';

// Hard cap so a huge range can't fan out into hundreds of OpenAI calls.
const MAX_DAYS = 92;

export interface DiscordRangeDigestResult {
  days: number; // days in range considered (after the cap)
  generated: number; // digests (re)written
  skipped: number; // empty / locked / unchanged days
  capped: boolean; // true if the range exceeded MAX_DAYS
}

/**
 * Enumerates the calendar days from `startDate` to `endDate` inclusive as
 * `YYYY-MM-DD` strings. Stepping by 24h at UTC midnight is DST-safe (UTC has no
 * DST) and the date slice is timezone-independent. Caps at `MAX_DAYS` (oldest
 * first) — the returned `capped` flag tells the caller it was truncated.
 */
export function enumerateDays(
  startDate: string,
  endDate: string,
  cap = MAX_DAYS,
): { days: string[]; capped: boolean } {
  const days: string[] = [];
  let cur = Date.parse(`${startDate}T00:00:00Z`);
  const last = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(cur) || Number.isNaN(last)) {
    throw new Error(`invalid range: ${startDate}..${endDate}`);
  }
  let capped = false;
  while (cur <= last) {
    if (days.length >= cap) {
      capped = true;
      break;
    }
    days.push(new Date(cur).toISOString().slice(0, 10));
    cur += 24 * 60 * 60 * 1000;
  }
  return { days, capped };
}

export async function discordRangeDigestFlow(
  repoId: string,
  startDate: string,
  endDate: string,
): Promise<DiscordRangeDigestResult> {
  const { days, capped } = enumerateDays(startDate, endDate);
  logger.info('discordRangeDigestFlow: start', {
    repoId,
    startDate,
    endDate,
    days: days.length,
    capped,
  });

  let generated = 0;
  let skipped = 0;

  for (const date of days) {
    // Cheap count of the day's messages (no OpenAI). Skip empty days.
    const { start, end } = taipeiDayBounds(date);
    const countSnap = await db
      .collection(`apps/gitsync/repos/${repoId}/discordMessages`)
      .where('timestamp', '>=', start)
      .where('timestamp', '<', end)
      .count()
      .get();
    const count = countSnap.data().count;
    if (count === 0) {
      skipped++;
      continue;
    }

    // Skip locked or unchanged days (no OpenAI call for those).
    const ref = db.doc(`apps/gitsync/repos/${repoId}/discordDigests/${date}`);
    const existing = await ref.get();
    const data = existing.data();
    if (data?.locked === true) {
      skipped++;
      continue;
    }
    if (existing.exists && data?.messageCount === count) {
      skipped++;
      continue; // already summarized at this message count
    }

    // (Re)generate. discordDailyDigestFlow re-checks locked + writes the doc.
    await discordDailyDigestFlow({ repoId, date });
    generated++;
  }

  logger.info('discordRangeDigestFlow: done', {
    repoId,
    generated,
    skipped,
    days: days.length,
  });
  return { days: days.length, generated, skipped, capped };
}
