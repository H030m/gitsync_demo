// Reusable, read-only data-access tools for the daily intelligence hub
// (summary tab). They power BOTH the agentic `summarizeDayFlow` (daily report
// generation) and `dailyBriefChatFlow` ("ask AI about today").
//
// Design mirrors `tools/discordSearch.ts` and `tools/assignTools.ts`:
//   - thin functions: read Firestore, normalize, return plain JSON shapes;
//   - never call OpenAI, never mutate state;
//   - BEST-EFFORT — a Firestore read failure degrades to []/null + a
//     `logger.warn`, so one missing signal never kills the whole flow.
//
// Day boundaries are Asia/Taipei (UTC+8), reusing `taipeiDayBounds` so the
// daily report and the Discord digest agree on what "one day" means.
import { logger } from 'firebase-functions/v2';
import type { Timestamp } from 'firebase-admin/firestore';

import { db } from '../admin';
import { taipeiDayBounds } from '../flows/discordDailyDigest';
import { readTeamState, type TeamMemberState } from './assignTools';
import { embed } from './embedding';

// Re-export the digest readers so callers get every day-intel tool from one
// module (the chat agent reads the Discord digest for "what was discussed").
export {
  getDaySummary as getDayDigest,
  listDaySummaries as listDayDigests,
  type DaySummary as DayDigest,
} from './discordSearch';

import type { DaySummary } from './discordSearch';

// ---- Range bounds -----------------------------------------------------------

/** Inclusive day range, both ends YYYY-MM-DD (Asia/Taipei). */
export interface DayRange {
  startDate: string;
  endDate: string;
}

/**
 * [startInclusive, endExclusive) Firestore Timestamps covering the inclusive
 * Asia/Taipei day range `startDate..endDate`. Throws on malformed dates or a
 * reversed range (callers validate user input before reaching here).
 */
export function taipeiRangeBounds(
  startDate: string,
  endDate: string,
): { start: Timestamp; end: Timestamp } {
  const start = taipeiDayBounds(startDate).start;
  const end = taipeiDayBounds(endDate).end;
  if (end.toMillis() <= start.toMillis()) {
    throw new Error(`invalid range: ${startDate}..${endDate}`);
  }
  return { start, end };
}

// ---- listDayCommits --------------------------------------------------------

/** A commit as the day-intel tools (and the report agent) see it. */
export interface DayCommit {
  sha: string;
  message: string; // first line only (keeps the agent prompt bounded)
  authorLogin: string;
  authorName: string;
  aiSummary: string | null; // one-line summary from onCommitCreated
  linkedTaskIds: string[];
  additions: number;
  deletions: number;
  committedAt: string | null; // ISO 8601 (UTC); when the commit was authored
}

const RANGE_COMMIT_LIMIT = 500;

/**
 * Commits committed within the inclusive Asia/Taipei day range, oldest first.
 * Returns [] on a malformed range or a read failure (best-effort).
 */
export async function listRangeCommits(
  repoId: string,
  startDate: string,
  endDate: string,
): Promise<DayCommit[]> {
  try {
    const { start, end } = taipeiRangeBounds(startDate, endDate);
    const snap = await db
      .collection(`apps/gitsync/repos/${repoId}/commits`)
      .where('committedAt', '>=', start)
      .where('committedAt', '<', end)
      .orderBy('committedAt', 'asc')
      .limit(RANGE_COMMIT_LIMIT)
      .get();
    return snap.docs.map((d) => toDayCommit(d.id, d.data() ?? {}));
  } catch (err) {
    logger.warn('listRangeCommits failed; returning [] (best-effort)', {
      repoId,
      startDate,
      endDate,
      err: String(err),
    });
    return [];
  }
}

/** Single-day convenience wrapper over {@link listRangeCommits}. */
export function listDayCommits(
  repoId: string,
  date: string,
): Promise<DayCommit[]> {
  return listRangeCommits(repoId, date, date);
}

function toDayCommit(sha: string, data: Record<string, unknown>): DayCommit {
  const author = (data.author as Record<string, unknown> | undefined) ?? {};
  const message = ((data.message as string | undefined) ?? '').split('\n')[0];
  return {
    sha,
    message,
    authorLogin: (author.login as string | undefined) ?? '',
    authorName: (author.name as string | undefined) ?? '',
    aiSummary: (data.aiSummary as string | undefined) ?? null,
    linkedTaskIds: (data.linkedTaskIds as string[] | undefined) ?? [],
    additions: (data.additions as number | undefined) ?? 0,
    deletions: (data.deletions as number | undefined) ?? 0,
    committedAt: toIso(data.committedAt),
  };
}

/** A Firestore Timestamp / ISO string / millis → ISO 8601, else null. */
function toIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  const ms = (value as { _seconds?: number; seconds?: number })._seconds ??
    (value as { seconds?: number }).seconds;
  if (typeof ms === 'number') return new Date(ms * 1000).toISOString();
  return null;
}

// ---- listCompletedTasks ----------------------------------------------------

/** A task that reached `done` on the given day, as the agent sees it. */
export interface DayTask {
  id: string;
  title: string;
  assigneeId: string | null;
  description: string;
}

const RANGE_TASK_LIMIT = 200;

/**
 * Tasks whose status is `done` and whose `updatedAt` lands inside the
 * inclusive Asia/Taipei day range. (Tasks carry no dedicated `completedAt`; a
 * done task's last update is its completion — see models/task.dart.) Requires
 * the `tasks status+updatedAt` composite index in live mode. Best-effort → [].
 */
export async function listRangeCompletedTasks(
  repoId: string,
  startDate: string,
  endDate: string,
): Promise<DayTask[]> {
  try {
    const { start, end } = taipeiRangeBounds(startDate, endDate);
    const snap = await db
      .collection(`apps/gitsync/repos/${repoId}/tasks`)
      .where('status', '==', 'done')
      .where('updatedAt', '>=', start)
      .where('updatedAt', '<', end)
      .limit(RANGE_TASK_LIMIT)
      .get();
    return snap.docs.map((d) => {
      const t = d.data() ?? {};
      return {
        id: d.id,
        title: (t.title as string | undefined) ?? '',
        assigneeId: (t.assigneeId as string | undefined) ?? null,
        description: (t.description as string | undefined) ?? '',
      };
    });
  } catch (err) {
    logger.warn('listRangeCompletedTasks failed; returning [] (best-effort)', {
      repoId,
      startDate,
      endDate,
      err: String(err),
    });
    return [];
  }
}

/** Single-day convenience wrapper over {@link listRangeCompletedTasks}. */
export function listCompletedTasks(
  repoId: string,
  date: string,
): Promise<DayTask[]> {
  return listRangeCompletedTasks(repoId, date, date);
}

// ---- Discord across a range -------------------------------------------------

const RANGE_DIGEST_LIMIT = 92; // mirrors the Discord backfill cap
const RANGE_MESSAGE_LIMIT = 500;

/**
 * The per-day AI Discord digests whose date falls inside the inclusive range,
 * oldest first. This is the cheap O(days) way to read "what was discussed"
 * across a period. Best-effort → [].
 */
export async function listRangeDigests(
  repoId: string,
  startDate: string,
  endDate: string,
): Promise<DaySummary[]> {
  try {
    const snap = await db
      .collection(`apps/gitsync/repos/${repoId}/discordDigests`)
      .where('date', '>=', startDate)
      .where('date', '<=', endDate)
      .orderBy('date', 'asc')
      .limit(RANGE_DIGEST_LIMIT)
      .get();
    return snap.docs.map((d) => {
      const data = d.data() ?? {};
      return {
        date: (data.date as string | undefined) ?? d.id,
        messageCount: (data.messageCount as number | undefined) ?? 0,
        markdown: (data.markdown as string | undefined) ?? '',
      };
    });
  } catch (err) {
    logger.warn('listRangeDigests failed; returning [] (best-effort)', {
      repoId,
      startDate,
      endDate,
      err: String(err),
    });
    return [];
  }
}

/** A raw Discord message as the range tools expose it (compact). */
export interface RangeDiscordMessage {
  authorName: string;
  content: string;
  timestamp: string | null; // ISO 8601
}

/**
 * Raw Discord messages inside the inclusive Asia/Taipei day range, oldest
 * first, capped at {@link RANGE_MESSAGE_LIMIT}. The fallback when a day has no
 * digest (e.g. it was never backfilled). Best-effort → [].
 */
export async function listRangeDiscordMessages(
  repoId: string,
  startDate: string,
  endDate: string,
  limit = RANGE_MESSAGE_LIMIT,
): Promise<RangeDiscordMessage[]> {
  const cap = Math.max(1, Math.min(limit, RANGE_MESSAGE_LIMIT));
  try {
    const { start, end } = taipeiRangeBounds(startDate, endDate);
    const snap = await db
      .collection(`apps/gitsync/repos/${repoId}/discordMessages`)
      .where('timestamp', '>=', start)
      .where('timestamp', '<', end)
      .orderBy('timestamp', 'asc')
      .limit(cap)
      .get();
    return snap.docs.map((d) => {
      const m = d.data() ?? {};
      const ts = m.timestamp;
      return {
        authorName:
          (m.authorName as string | undefined) ??
          (m.authorId as string | undefined) ??
          'unknown',
        content: (m.content as string | undefined) ?? '',
        timestamp:
          ts && typeof (ts as { toDate?: unknown }).toDate === 'function'
            ? (ts as { toDate: () => Date }).toDate().toISOString()
            : typeof ts === 'string'
              ? ts
              : null,
      };
    });
  } catch (err) {
    logger.warn('listRangeDiscordMessages failed; returning [] (best-effort)', {
      repoId,
      startDate,
      endDate,
      err: String(err),
    });
    return [];
  }
}

// ---- searchPastCommits -----------------------------------------------------

const PAST_SCAN_LIMIT = 300;
const PAST_DEFAULT = 8;
const PAST_MAX = 20;

/** Lowercase word tokens of length >= 2. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

/**
 * Search the repo's commit history (across days) so the brief-chat agent can
 * answer "when did we last touch X / who wrote Y". VECTOR-FIRST: when the query
 * has usable terms, embed it and run a `findNearest` over the `commits` vector
 * index (prefiltered by `repoId`, COSINE) — the same `repoId + messageEmbedding`
 * COLLECTION-scope index `searchMemberCommits` uses, minus the `author.login`
 * predicate. Degrades to the keyword + recency ranker over the latest
 * {@link PAST_SCAN_LIMIT} commits on an empty query, an embedding/`findNearest`
 * failure (missing index, fake backend), or zero hits. Returns `DayCommit[]`
 * either way. Best-effort → [].
 */
export async function searchPastCommits(
  repoId: string,
  query: string,
  limit = PAST_DEFAULT,
): Promise<DayCommit[]> {
  const cap = Math.max(1, Math.min(limit, PAST_MAX));

  // ---- Vector-first path (skip when the query has no usable terms) ---------
  if (new Set(tokenize(query)).size > 0) {
    try {
      const queryVector = await embed(query);
      const snap = await db
        .collection(`apps/gitsync/repos/${repoId}/commits`)
        .where('repoId', '==', repoId)
        .findNearest({
          vectorField: 'messageEmbedding',
          queryVector,
          limit: cap,
          distanceMeasure: 'COSINE',
        })
        .get();
      if (!snap.empty) {
        return snap.docs.map((d) => toDayCommit(d.id, d.data() ?? {}));
      }
      // 0 hits → fall through to the keyword path below.
    } catch (err) {
      // Embedding or findNearest failed (missing index, fake backend, etc.).
      logger.warn('searchPastCommits: vector path unavailable (keyword fallback)', {
        repoId,
        err: String(err),
      });
    }
  }

  // ---- Keyword + recency fallback ------------------------------------------
  try {
    const snap = await db
      .collection(`apps/gitsync/repos/${repoId}/commits`)
      .orderBy('committedAt', 'desc')
      .limit(PAST_SCAN_LIMIT)
      .get();
    const commits = snap.docs.map((d) => toDayCommit(d.id, d.data() ?? {}));

    const terms = new Set(tokenize(query));
    if (terms.size === 0) return commits.slice(0, cap);

    const scored = commits
      .map((c) => {
        const hay = `${c.message} ${c.aiSummary ?? ''}`.toLowerCase();
        let score = 0;
        for (const t of terms) if (hay.includes(t)) score++;
        return { c, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    return (scored.length ? scored.map((s) => s.c) : commits).slice(0, cap);
  } catch (err) {
    logger.warn('searchPastCommits failed; returning [] (best-effort)', {
      repoId,
      err: String(err),
    });
    return [];
  }
}

// ---- computeContributions --------------------------------------------------

/** Per-member tallies for one day, keyed by userId. */
export type MemberContributions = Record<
  string,
  {
    tasksDone: number;
    commits: number;
    githubLogin: string | null;
    displayName: string;
  }
>;

/**
 * Deterministically tally per-member contributions from the day's commits +
 * completed tasks. Counting is done in TS (never delegated to the LLM, which
 * cannot be trusted to count) keyed by `userId`:
 *   - commits are attributed via `author.login → userId` using the roster;
 *     commits whose author maps to no member are bucketed under their login so
 *     they are still surfaced.
 *   - tasksDone is counted per `assigneeId`.
 *
 * Each entry also carries `githubLogin`/`displayName` resolved from the roster
 * at generation time, so the Flutter Contributions card can render a human
 * name instead of the raw Firebase UID key (legacy reports lack these fields —
 * the client falls back to the key).
 */
export function computeContributions(
  commits: DayCommit[],
  tasks: DayTask[],
  roster: TeamMemberState[],
): MemberContributions {
  const loginToUser = new Map<string, string>();
  const userById = new Map<string, TeamMemberState>();
  for (const m of roster) {
    userById.set(m.userId, m);
    if (m.githubLogin) loginToUser.set(m.githubLogin.toLowerCase(), m.userId);
  }

  const out: MemberContributions = {};
  const bump = (key: string, field: 'tasksDone' | 'commits') => {
    if (!key) return;
    // Resolve identity once, on first sight of the key. A key that isn't a
    // roster userId is an unmatched commit author's GitHub login.
    const member = userById.get(key);
    const cur = out[key] ?? {
      tasksDone: 0,
      commits: 0,
      githubLogin: member ? member.githubLogin : key,
      displayName: member ? (member.name ?? member.githubLogin ?? key) : key,
    };
    cur[field] += 1;
    out[key] = cur;
  };

  for (const c of commits) {
    const key = loginToUser.get(c.authorLogin.toLowerCase()) ?? c.authorLogin;
    bump(key, 'commits');
  }
  for (const t of tasks) {
    if (t.assigneeId) bump(t.assigneeId, 'tasksDone');
  }
  return out;
}

/** Thin wrapper so the flow can fetch the roster without importing assignTools. */
export async function readRoster(repoId: string): Promise<TeamMemberState[]> {
  try {
    return await readTeamState(repoId);
  } catch (err) {
    logger.warn('readRoster failed; returning [] (best-effort)', {
      repoId,
      err: String(err),
    });
    return [];
  }
}
