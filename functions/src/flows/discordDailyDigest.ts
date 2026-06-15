// discordDailyDigestFlow — reads one day's Discord messages for a repo and
// writes an AI-generated markdown digest to
// `apps/gitsync/repos/{repoId}/discordDigests/{date}`. Invoked by
// `completeDiscordFetch` after the bot backfills the day's messages.
//
// Day boundaries are Asia/Taipei (UTC+8, no DST) to match the team's timezone.
import { logger } from 'firebase-functions/v2';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { db } from '../admin';
import { getOpenAI, MODELS } from '../config';
import {
  discordDailyDigestSystem,
  discordDailyDigestUser,
} from '../prompts/discordDailyDigest';

// Taipei is a fixed UTC+8 offset year-round.
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

// How many source messages to persist alongside the digest (for the "referenced
// messages" panel), and how far to trim each one's content.
const MAX_SOURCE_MESSAGES = 50;
const SOURCE_CONTENT_CHARS = 280;

export interface DiscordDailyDigestInput {
  repoId: string;
  date: string; // YYYY-MM-DD
}

export interface DiscordDailyDigestResult {
  date: string;
  messageCount: number;
  /** Markdown digest, or null when the day had no messages. */
  markdown: string | null;
}

// Returns [startInclusive, endExclusive) as Firestore Timestamps for the given
// Asia/Taipei calendar day. Throws on a malformed date string.
export function taipeiDayBounds(date: string): { start: Timestamp; end: Timestamp } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`invalid date: ${date}`);
  }
  // Midnight Taipei == 16:00 UTC the previous day. Parsing the date as UTC and
  // subtracting the offset gives the correct instant.
  const utcMidnight = new Date(`${date}T00:00:00Z`).getTime();
  if (Number.isNaN(utcMidnight)) {
    throw new Error(`invalid date: ${date}`);
  }
  const startMs = utcMidnight - TAIPEI_OFFSET_MS;
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return {
    start: Timestamp.fromMillis(startMs),
    end: Timestamp.fromMillis(endMs),
  };
}

export async function discordDailyDigestFlow(
  input: DiscordDailyDigestInput,
): Promise<DiscordDailyDigestResult> {
  const { repoId, date } = input;

  // ---- Step 1: read the day's messages (Taipei day boundaries) -------------
  logger.info('Step 1: read discord messages for day', { repoId, date });
  const { start, end } = taipeiDayBounds(date);
  const snap = await db
    .collection(`apps/gitsync/repos/${repoId}/discordMessages`)
    .where('timestamp', '>=', start)
    .where('timestamp', '<', end)
    .orderBy('timestamp', 'asc')
    .get();

  // ---- Step 2: early-return on an empty day (no OpenAI call) ----------------
  if (snap.empty) {
    logger.info('No discord messages for day; skipping digest', { repoId, date });
    return { date, messageCount: 0, markdown: null };
  }

  const transcript = snap.docs
    .map((d) => {
      const m = d.data();
      const author = (m.authorName as string) ?? (m.authorId as string) ?? 'unknown';
      const content = (m.content as string) ?? '';
      return `${author}: ${content}`;
    })
    .join('\n');

  // Capture the messages the summary is built from, so the digest card can cite
  // them with timestamps ("referenced what, and when") instead of only an
  // outline. Capped + content-trimmed to keep the digest doc bounded.
  const sourceMessages = snap.docs.slice(0, MAX_SOURCE_MESSAGES).map((d) => {
    const m = d.data();
    const ts = m.timestamp;
    return {
      authorName: (m.authorName as string) ?? (m.authorId as string) ?? 'unknown',
      content: ((m.content as string) ?? '').slice(0, SOURCE_CONTENT_CHARS),
      timestamp:
        ts && typeof (ts as { toDate?: unknown }).toDate === 'function'
          ? (ts as { toDate: () => Date }).toDate().toISOString()
          : typeof ts === 'string'
            ? ts
            : null,
    };
  });

  // ---- Step 3: summarize via OpenAI ----------------------------------------
  logger.info('Step 3: call OpenAI for digest', { repoId, date, count: snap.size });
  const completion = await getOpenAI().chat.completions.create({
    model: MODELS.fast,
    messages: [
      { role: 'system', content: discordDailyDigestSystem },
      { role: 'user', content: discordDailyDigestUser({ date, transcript }) },
    ],
  });
  const markdown = completion.choices[0]?.message?.content?.trim() ?? '';

  // ---- Step 4: write the digest doc ----------------------------------------
  // A locked digest is frozen — never overwrite it (the user pinned it). The
  // lock is the single gate every digest-write path checks (see ARCHITECTURE §7).
  const ref = db.doc(`apps/gitsync/repos/${repoId}/discordDigests/${date}`);
  const existing = await ref.get();
  if (existing.exists && existing.data()?.locked === true) {
    logger.info('Step 4: digest locked; skipping regeneration', { repoId, date });
    return {
      date,
      messageCount: snap.size,
      markdown: (existing.data()?.markdown as string | undefined) ?? null,
    };
  }

  logger.info('Step 4: write digest doc', { repoId, date });
  await ref.set({
    date,
    markdown,
    messageCount: snap.size,
    sourceMessages,
    generatedAt: FieldValue.serverTimestamp(),
  });

  return { date, messageCount: snap.size, markdown };
}
