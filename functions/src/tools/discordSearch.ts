// Reusable tool helper for discordChatFlow (ARCHITECTURE §7).
//
// `searchDiscordMessages` is the single data-access primitive the discord-chat
// agentic loop exposes to OpenAI as a function tool. It reads the repo's
// ingested Discord messages and ranks them against a natural-language query.
//
// Retrieval is VECTOR-FIRST with a keyword + recency FALLBACK: when the repo's
// messages carry an `embedding` vector (written by `onDiscordMessageCreated`),
// a `findNearest` semantic search decides which messages match the query; the
// matched ids are then grouped with surrounding context by the same snippet
// builder the keyword path uses. If embedding/`findNearest` fails (or the
// query is empty, or nothing matches, e.g. the fake backend with no vectors),
// it degrades to the keyword + recency ranker — no vector index needed.
import { logger } from 'firebase-functions/v2';
import type { Timestamp } from 'firebase-admin/firestore';
import { db } from '../admin';
import { embed } from './embedding';

/**
 * Inclusive Asia/Taipei day window the chat is scoped to. `start`/`end` are the
 * [startInclusive, endExclusive) Firestore Timestamps (from taipeiRangeBounds);
 * `startDate`/`endDate` are the YYYY-MM-DD keys for filtering digest doc ids.
 */
export interface SearchRange {
  start: Timestamp;
  end: Timestamp;
  startDate: string;
  endDate: string;
}

/** One Discord message as the chat agent (and the client UI) sees it. */
export interface DiscordMessageHit {
  messageId: string;
  channelId: string;
  authorName: string; // display name (guild nickname → global → @handle)
  authorUsername?: string; // raw @handle (for author-filter matching)
  content: string;
  timestamp: string | null; // ISO 8601, or null if missing
  isMatch: boolean; // true if it matched the query (vs. surrounding context)
}

// How many recent messages we pull before grouping into snippets. This same
// window supplies the ±context for vector hits (Q3): hits inside it get full
// context, hits outside are emitted as single-message snippets.
const SCAN_LIMIT = 300;

// How many semantic hits `findNearest` returns. We over-fetch (vs. the snippet
// cap) so the in-memory timestamp post-filter for `range` still has candidates.
const VECTOR_LIMIT = 20;

// How many day summaries `listDaySummaries` returns, and the preview length.
const MAX_DAY_SUMMARIES = 60;
const DAY_PREVIEW_CHARS = 180;

/** A per-day digest as the chat agent sees it in `listDaySummaries` (small). */
export interface DaySummaryHit {
  date: string; // YYYY-MM-DD
  messageCount: number;
  preview: string; // first ~180 chars of the day's markdown digest
}

/** A full day digest from `getDaySummary`. */
export interface DaySummary {
  date: string;
  messageCount: number;
  markdown: string;
}

/**
 * List the available per-day digests for a repo (newest first), each as a tiny
 * preview. This is the CHEAP first stop for summary / overview questions: the
 * agent scans dates + topics here (O(days) tokens) and only drills into a
 * specific day's full text via {@link getDaySummary}, instead of reading every
 * raw message. When `range` is given, only digests for days within
 * [startDate, endDate] (inclusive) are returned. Never throws — degrades to [].
 */
export async function listDaySummaries(
  repoId: string,
  range?: SearchRange,
): Promise<DaySummaryHit[]> {
  try {
    const snap = await db
      .collection(`apps/gitsync/repos/${repoId}/discordDigests`)
      .orderBy('date', 'desc')
      .limit(MAX_DAY_SUMMARIES)
      .get();

    return snap.docs
      .filter((d) => {
        if (!range) return true;
        // Digest doc ids (and `date` fields) are YYYY-MM-DD → lexicographic
        // comparison equals chronological; restrict to the active window.
        const key = ((d.data()?.date as string | undefined) ?? d.id);
        return key >= range.startDate && key <= range.endDate;
      })
      .map((d) => {
        const data = d.data() ?? {};
        const md = (data.markdown as string | undefined) ?? '';
        return {
          date: (data.date as string | undefined) ?? d.id,
          messageCount: (data.messageCount as number | undefined) ?? 0,
          preview: md.replace(/\s+/g, ' ').trim().slice(0, DAY_PREVIEW_CHARS),
        };
      });
  } catch (err) {
    logger.warn('listDaySummaries failed; returning [] (best-effort)', {
      repoId,
      err: String(err),
    });
    return [];
  }
}

/**
 * Full markdown digest for one day, or null if that day has no digest yet.
 * Never throws — degrades to null.
 */
export async function getDaySummary(
  repoId: string,
  date: string,
): Promise<DaySummary | null> {
  try {
    const doc = await db
      .doc(`apps/gitsync/repos/${repoId}/discordDigests/${date}`)
      .get();
    if (!doc.exists) return null;
    const data = doc.data() ?? {};
    return {
      date: (data.date as string | undefined) ?? date,
      messageCount: (data.messageCount as number | undefined) ?? 0,
      markdown: (data.markdown as string | undefined) ?? '',
    };
  } catch (err) {
    logger.warn('getDaySummary failed; returning null (best-effort)', {
      repoId,
      date,
      err: String(err),
    });
    return null;
  }
}

/** How many messages of context to include before/after each matched message. */
const CONTEXT_BEFORE = 2;
const CONTEXT_AFTER = 2;
const DEFAULT_SNIPPETS = 6;
const MAX_SNIPPETS = 12;

/**
 * A conversation snippet: a run of chronologically-ordered messages from ONE
 * channel, centered on the message(s) that matched the query (`isMatch: true`)
 * with a few surrounding messages for context. This is what the chat agent and
 * the UI panel consume — grouped clusters, NOT a flat dump.
 */
export interface DiscordSnippet {
  channelId: string;
  messages: DiscordMessageHit[]; // oldest → newest, context + matches
  score: number; // number of matched messages (for ranking)
}

/** Lowercase word tokens of length >= 2 (drops punctuation + stopword-ish noise). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

/** -1 / 0 / 1 comparison of two snowflake id strings by BigInt value. */
function cmpId(a: string, b: string): number {
  const x = BigInt(a || '0');
  const y = BigInt(b || '0');
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Keyword search over a repo's `discordMessages`, returning grouped conversation
 * snippets (each matched message bundled with {@link CONTEXT_BEFORE}/
 * {@link CONTEXT_AFTER} surrounding messages from the same channel; overlapping
 * windows merge). Snippets are ranked by match count then recency. When nothing
 * matches, degrades to one snippet of the most recent messages.
 *
 * Vector-first: when the query has usable terms, embed it and run a
 * `findNearest` over the COLLECTION_GROUP `discordMessages` vector index
 * (prefiltered by `repoId`); the hit ids become the `isMatch` set fed to
 * {@link buildSnippetsFromMatches}, which pulls ±context from the recent scan
 * window. Degrades to the keyword + recency path on an empty query, an
 * embedding/`findNearest` failure, or zero hits.
 *
 * When `range` is given the scan is restricted to messages whose `timestamp`
 * falls in [start, end) (same field as the orderBy → no composite index). The
 * vector path can't combine `findNearest` with a timestamp inequality, so it
 * over-fetches without the range and post-filters hits in memory; if none
 * survive the window it falls back to the (range-aware) keyword path.
 *
 * Never throws — a Firestore read failure degrades to `[]` + a `logger.warn`.
 */
export async function searchDiscordMessages(
  repoId: string,
  query: string,
  limit = DEFAULT_SNIPPETS,
  range?: SearchRange,
  author?: string,
): Promise<DiscordSnippet[]> {
  try {
    // ---- Author-scoped path: "what did <person> say" -----------------------
    // When an author is named, retrieval is BY AUTHOR (display name OR @handle,
    // fuzzy), not by content vector — querying a person's name semantically
    // doesn't surface their messages. Optionally AND-filtered by query terms.
    const authorTerm = author?.trim().toLowerCase();
    if (authorTerm) {
      const docs = await scanRecentMessages(repoId, range);
      const queryTerms = new Set(tokenize(query));
      const byAuthor = (m: DiscordMessageHit): boolean => {
        const name = m.authorName.toLowerCase();
        const handle = (m.authorUsername ?? '').toLowerCase();
        if (!name.includes(authorTerm) && !handle.includes(authorTerm)) return false;
        if (queryTerms.size === 0) return true;
        const hay = m.content.toLowerCase();
        for (const t of queryTerms) if (hay.includes(t)) return true;
        return false;
      };
      // Honest empty: if this person has no matching message in the window,
      // return [] (NOT a recent-messages fallback) so the agent says "nothing
      // from X here" instead of summarizing unrelated recent chatter.
      if (!docs.some(byAuthor)) return [];
      return groupByMatches(docs, byAuthor, { maxSnippets: limit });
    }

    // ---- Vector-first path (skip when the query has no usable terms) -------
    const hasTerms = tokenize(query).length > 0;
    if (hasTerms) {
      const matched = await vectorMatchIds(repoId, query, range);
      if (matched && matched.size > 0) {
        const docs = await scanRecentMessages(repoId, range);
        return buildSnippetsFromMatches(docs, matched, { maxSnippets: limit });
      }
      // null (vector unavailable) or empty (no hits) → keyword fallback below.
    }

    // ---- Keyword + recency fallback ----------------------------------------
    const docs = await scanRecentMessages(repoId, range);
    return buildSnippets(docs, query, { maxSnippets: limit });
  } catch (err) {
    logger.warn('searchDiscordMessages failed; returning [] (best-effort)', {
      repoId,
      err: String(err),
    });
    return [];
  }
}

/**
 * Semantic-match the query against the repo's `discordMessages` and return the
 * set of matching message ids, or `null` when the vector path is unavailable
 * (embedding failed, or `findNearest` threw — e.g. a missing index
 * `9 FAILED_PRECONDITION`, or the fake backend). A `null` return signals the
 * caller to fall back to keyword search; an empty set means "ran, no hits".
 *
 * Uses the COLLECTION_GROUP vector index via
 * `collectionGroup('discordMessages').where('repoId','==',repoId)` (Q1). When
 * `range` is set, hits are over-fetched and post-filtered by timestamp in
 * memory (findNearest can't take an inequality prefilter — Q2).
 */
async function vectorMatchIds(
  repoId: string,
  query: string,
  range?: SearchRange,
): Promise<Set<string> | null> {
  try {
    const queryVector = await embed(query);
    const snap = await db
      .collectionGroup('discordMessages')
      .where('repoId', '==', repoId)
      .findNearest({
        vectorField: 'embedding',
        queryVector,
        limit: VECTOR_LIMIT,
        distanceMeasure: 'COSINE',
      })
      .get();

    const startMs = range?.start.toMillis();
    const endMs = range?.end.toMillis();
    const ids = new Set<string>();
    for (const d of snap.docs) {
      if (range) {
        const ms = tsToMillis(d.data()?.timestamp);
        // Post-filter to [start, end); drop hits without a usable timestamp.
        if (ms === null || ms < startMs! || ms >= endMs!) continue;
      }
      ids.add(d.id);
    }
    return ids;
  } catch (err) {
    // Embedding or findNearest failed (missing index, fake backend, etc.).
    logger.warn('searchDiscordMessages: vector path unavailable (keyword fallback)', {
      repoId,
      err: String(err),
    });
    return null;
  }
}

/**
 * Pull the recent {@link SCAN_LIMIT} messages (range-restricted when given) and
 * normalize them to {@link DiscordMessageHit}s. Shared by the keyword fallback
 * and the vector path (which needs this window to draw ±context around hits).
 */
async function scanRecentMessages(
  repoId: string,
  range?: SearchRange,
): Promise<DiscordMessageHit[]> {
  let q: FirebaseFirestore.Query = db.collection(
    `apps/gitsync/repos/${repoId}/discordMessages`,
  );
  if (range) {
    q = q
      .where('timestamp', '>=', range.start)
      .where('timestamp', '<', range.end);
  }
  const snap = await q.orderBy('timestamp', 'desc').limit(SCAN_LIMIT).get();
  return snap.docs.map((d) => {
    const data = d.data() ?? {};
    return {
      messageId: d.id,
      channelId: (data.channelId as string | undefined) ?? '',
      authorName: (data.authorName as string | undefined) ?? '',
      authorUsername: (data.authorUsername as string | undefined) ?? undefined,
      content: (data.content as string | undefined) ?? '',
      isMatch: false,
      timestamp: tsToIso(data.timestamp),
    };
  });
}

/** Firestore Timestamp → ISO; tolerate already-string / missing values. */
function tsToIso(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: unknown }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof ts === 'string' ? ts : null;
}

/** Firestore Timestamp → epoch ms, or null when not a usable Timestamp. */
function tsToMillis(ts: unknown): number | null {
  if (ts && typeof (ts as { toMillis?: unknown }).toMillis === 'function') {
    return (ts as { toMillis: () => number }).toMillis();
  }
  return null;
}

/**
 * Pure snippet builder (no I/O) — extracted for unit tests. Groups matched
 * messages with surrounding context, per channel, merging overlapping windows.
 * `docs` may arrive in any order; they are re-sorted by snowflake id per
 * channel. When the query has no usable terms OR nothing matches, returns a
 * single snippet of the most recent messages (so the agent isn't empty-handed).
 */
export function buildSnippets(
  docs: DiscordMessageHit[],
  query: string,
  opts?: { before?: number; after?: number; maxSnippets?: number },
): DiscordSnippet[] {
  const terms = new Set(tokenize(query));
  if (terms.size === 0) return recentFallback(docs, opts);

  const matches = (m: DiscordMessageHit): boolean => {
    const hay = m.content.toLowerCase();
    for (const t of terms) if (hay.includes(t)) return true;
    return false;
  };
  return groupByMatches(docs, matches, opts);
}

/**
 * Snippet builder for the VECTOR path (no I/O) — same grouping/ranking as
 * {@link buildSnippets}, but the match predicate is "this message id is in the
 * semantic-hit set" instead of a keyword test. `docs` is the recent scan
 * window; hits inside it gain ±context, hits absent from the window simply
 * don't appear (acceptable per Q3 — emitted single without context only if
 * they happen to be in-window with no neighbours). Falls back to a recent
 * snippet when `matchedIds` is empty.
 */
export function buildSnippetsFromMatches(
  docs: DiscordMessageHit[],
  matchedIds: Set<string>,
  opts?: { before?: number; after?: number; maxSnippets?: number },
): DiscordSnippet[] {
  if (matchedIds.size === 0) return recentFallback(docs, opts);
  return groupByMatches(docs, (m) => matchedIds.has(m.messageId), opts);
}

/** Most-recent context window as a single matchless snippet (shared fallback). */
function recentFallback(
  docs: DiscordMessageHit[],
  opts?: { before?: number; after?: number },
): DiscordSnippet[] {
  const before = opts?.before ?? CONTEXT_BEFORE;
  const after = opts?.after ?? CONTEXT_AFTER;
  const recent = [...docs]
    .sort((a, b) => cmpId(b.messageId, a.messageId))
    .slice(0, before + after + 1)
    .sort((a, b) => cmpId(a.messageId, b.messageId))
    .map((m) => ({ ...m, isMatch: false }));
  return recent.length
    ? [{ channelId: recent[0].channelId, messages: recent, score: 0 }]
    : [];
}

/**
 * Core grouping logic shared by the keyword and vector snippet builders: group
 * `docs` per channel (sorted by snowflake id), expand each match into a
 * [k-before, k+after] window, merge overlapping windows, score by match count,
 * and rank by matches then recency. `isMatch` decides which messages are hits.
 */
function groupByMatches(
  docs: DiscordMessageHit[],
  isMatch: (m: DiscordMessageHit) => boolean,
  opts?: { before?: number; after?: number; maxSnippets?: number },
): DiscordSnippet[] {
  const before = opts?.before ?? CONTEXT_BEFORE;
  const after = opts?.after ?? CONTEXT_AFTER;
  const maxSnippets = Math.max(1, Math.min(opts?.maxSnippets ?? DEFAULT_SNIPPETS, MAX_SNIPPETS));

  // Group by channel, sort each channel chronologically (by snowflake id).
  const byChannel = new Map<string, DiscordMessageHit[]>();
  for (const d of docs) {
    const arr = byChannel.get(d.channelId);
    if (arr) arr.push(d);
    else byChannel.set(d.channelId, [d]);
  }

  const snippets: DiscordSnippet[] = [];
  for (const [channelId, arrRaw] of byChannel) {
    const arr = [...arrRaw].sort((a, b) => cmpId(a.messageId, b.messageId));
    const hit = arr.map((m) => isMatch(m));

    // Merge each hit's [k-before, k+after] window into contiguous ranges.
    const ranges: Array<[number, number]> = [];
    for (let k = 0; k < arr.length; k++) {
      if (!hit[k]) continue;
      const lo = Math.max(0, k - before);
      const hi = Math.min(arr.length - 1, k + after);
      const last = ranges[ranges.length - 1];
      if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
      else ranges.push([lo, hi]);
    }

    for (const [lo, hi] of ranges) {
      const messages = arr
        .slice(lo, hi + 1)
        .map((m, idx) => ({ ...m, isMatch: hit[lo + idx] }));
      snippets.push({
        channelId,
        messages,
        score: messages.filter((m) => m.isMatch).length,
      });
    }
  }

  if (snippets.length === 0) return recentFallback(docs, opts);

  // Rank: more matches first, then most-recent (by the snippet's newest id).
  const lastId = (s: DiscordSnippet) => s.messages[s.messages.length - 1].messageId;
  snippets.sort((a, b) => b.score - a.score || cmpId(lastId(b), lastId(a)));
  return snippets.slice(0, maxSnippets);
}
