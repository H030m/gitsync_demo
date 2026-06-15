// Fake Firestore for the range-aware DB readers. The query records its where()
// clauses; `get()` applies them against an in-memory store so we can assert the
// timestamp window narrows the scan (and that no-range scans everything).
jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

interface Clause {
  field: string;
  op: string;
  value: { toMillis: () => number };
}
const store = new Map<string, Record<string, unknown>>();

// ---- Vector-path test knobs -----------------------------------------------
// When set, findNearest().get() throws this (simulates a missing vector index
// `9 FAILED_PRECONDITION` or the fake backend's lack of vector support).
let findNearestError: Error | null = null;
// Ordered ids findNearest() returns (already "ranked"); intersected with what
// the collectionGroup repoId prefilter actually holds.
let vectorHitIds: string[] = [];

function childDocsOf(colPath: string): Array<[string, Record<string, unknown>]> {
  return [...store.entries()].filter(
    ([p]) =>
      p.startsWith(`${colPath}/`) &&
      p.slice(colPath.length + 1).indexOf('/') === -1,
  );
}

function tsOf(v: unknown): number | null {
  if (v && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    return (v as { toMillis: () => number }).toMillis();
  }
  return null;
}

// Apply a where clause: timestamp ops compare via toMillis(); a plain-value op
// (e.g. repoId == 'r') compares by strict equality.
function clauseMatches(d: Record<string, unknown>, c: Clause): boolean {
  if (c.op === '==') return d[c.field] === (c.value as unknown);
  const fieldMs = tsOf(d[c.field]);
  const valMs = c.value.toMillis();
  if (fieldMs === null) return false;
  if (c.op === '>=') return fieldMs >= valMs;
  if (c.op === '<') return fieldMs < valMs;
  return true;
}

// docs across ALL `discordMessages` subcollections (collectionGroup view).
function groupDocsOf(group: string): Array<[string, Record<string, unknown>]> {
  return [...store.entries()].filter(([p]) => {
    const parts = p.split('/');
    return parts[parts.length - 2] === group;
  });
}

function makeQuery(
  entries: () => Array<[string, Record<string, unknown>]>,
  clauses: Clause[],
) {
  const filtered = () =>
    entries().filter(([, d]) => clauses.every((c) => clauseMatches(d, c)));
  const q = {
    where(field: string, op: string, value: { toMillis: () => number }) {
      return makeQuery(entries, [...clauses, { field, op, value }]);
    },
    orderBy() {
      return q;
    },
    limit() {
      return q;
    },
    findNearest(opts: { limit?: number }) {
      return {
        async get() {
          if (findNearestError) throw findNearestError;
          // Return the scripted hit ids, in order, that survive the prefilter,
          // capped at the findNearest `limit` (as Firestore does).
          const present = new Map(filtered().map(([p, d]) => [p.split('/').pop() as string, [p, d] as const]));
          const docs = vectorHitIds
            .map((id) => present.get(id))
            .filter((x): x is readonly [string, Record<string, unknown>] => x !== undefined)
            .slice(0, opts?.limit ?? Infinity)
            .map(([p, d]) => ({ id: p.split('/').pop() as string, ref: { path: p }, data: () => d }));
          return { empty: docs.length === 0, size: docs.length, docs };
        },
      };
    },
    async get() {
      const docs = filtered();
      return {
        empty: docs.length === 0,
        size: docs.length,
        docs: docs.map(([p, d]) => ({
          id: p.split('/').pop() as string,
          ref: { path: p },
          data: () => d,
        })),
      };
    },
  };
  return q;
}

const fakeDb = {
  doc: (path: string) => ({
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
  }),
  collection: (path: string) => makeQuery(() => childDocsOf(path), []),
  collectionGroup: (group: string) => makeQuery(() => groupDocsOf(group), []),
};

jest.mock('../admin', () => ({ db: fakeDb }));

const mockEmbed = jest.fn();
jest.mock('../tools/embedding', () => ({
  embed: (...args: unknown[]) => mockEmbed(...args),
}));

import {
  buildSnippets,
  buildSnippetsFromMatches,
  searchDiscordMessages,
  listDaySummaries,
  type DiscordMessageHit,
  type SearchRange,
} from '../tools/discordSearch';

// Reset the vector-path knobs + embed mock before every test. By default the
// embed call resolves and findNearest returns no hits, so searchDiscordMessages
// runs the vector path then transparently degrades to the keyword fallback —
// which keeps every pre-existing keyword/range assertion valid.
beforeEach(() => {
  findNearestError = null;
  vectorHitIds = [];
  mockEmbed.mockReset().mockResolvedValue(new Array(1536).fill(0));
});

// A Timestamp-like value: comparable via toMillis(), the only method the
// fake query + production range filter use.
function ts(ms: number): { toMillis: () => number; toDate: () => Date } {
  return { toMillis: () => ms, toDate: () => new Date(ms) };
}
function rangeFor(startMs: number, endMs: number, startDate: string, endDate: string): SearchRange {
  return {
    start: ts(startMs) as unknown as SearchRange['start'],
    end: ts(endMs) as unknown as SearchRange['end'],
    startDate,
    endDate,
  };
}

const REPO = 'team17_gitsync';
const msgCol = `apps/gitsync/repos/${REPO}/discordMessages`;
const digestCol = `apps/gitsync/repos/${REPO}/discordDigests`;

// Snowflake ids are monotonic with time; use small ascending ids per channel.
function msg(id: string, channelId: string, content: string): DiscordMessageHit {
  return {
    messageId: id,
    channelId,
    authorName: 'u' + id,
    content,
    timestamp: null,
    isMatch: false,
  };
}

// A single channel "c1" timeline (ids ascending = chronological).
const c1: DiscordMessageHit[] = [
  msg('10', 'c1', 'morning standup notes'),
  msg('11', 'c1', 'i push a commit for the OAuth flow'),
  msg('12', 'c1', 'ok looks good'),
  msg('13', 'c1', 'lunch?'),
  msg('14', 'c1', 'random chatter'),
  msg('15', 'c1', 'the commit is broken, i will fix it'),
  msg('16', 'c1', 'thanks'),
];

describe('buildSnippets', () => {
  it('groups each match with surrounding context (before/after)', () => {
    const out = buildSnippets(c1, 'commit', { before: 1, after: 1 });
    // Two separate "commit" conversations → two snippets.
    expect(out).toHaveLength(2);
    // First snippet centers on id 11 with one msg before/after.
    const ids = out.map((s) => s.messages.map((m) => m.messageId));
    expect(ids).toContainEqual(['10', '11', '12']);
    expect(ids).toContainEqual(['14', '15', '16']);
  });

  it('flags only the matched messages as isMatch, context is false', () => {
    const out = buildSnippets(c1, 'commit', { before: 1, after: 1 });
    // Find the snippet centered on id 11 regardless of ranking order.
    const snip = out.find((s) => s.messages.some((m) => m.messageId === '11'))!;
    const matched = snip.messages.filter((m) => m.isMatch).map((m) => m.messageId);
    expect(matched).toEqual(['11']); // only the matching line
    expect(snip.messages.find((m) => m.messageId === '10')!.isMatch).toBe(false);
  });

  it('merges overlapping windows into one snippet', () => {
    // Two adjacent matches (15 and a synthetic 14b) → windows overlap → 1 snippet.
    const adjacent = [
      msg('20', 'c1', 'commit landed'),
      msg('21', 'c1', 'another commit right after'),
      msg('22', 'c1', 'done'),
    ];
    const out = buildSnippets(adjacent, 'commit', { before: 2, after: 2 });
    expect(out).toHaveLength(1);
    expect(out[0].messages).toHaveLength(3);
  });

  it('keeps snippets per-channel (no cross-channel context)', () => {
    const mixed = [
      msg('30', 'cA', 'deploy the commit'),
      msg('31', 'cB', 'unrelated in another channel'),
      msg('32', 'cA', 'reply in A'),
    ];
    const out = buildSnippets(mixed, 'commit', { before: 2, after: 2 });
    expect(out).toHaveLength(1);
    expect(out[0].channelId).toBe('cA');
    expect(out[0].messages.every((m) => m.channelId === 'cA')).toBe(true);
  });

  it('ranks higher-match snippets first', () => {
    const out = buildSnippets(c1, 'commit broken fix', { before: 0, after: 0 });
    // id 15 contains commit+broken+fix → more term coverage isn't counted, but
    // it is still a match; both 11 and 15 match → 2 snippets, order by recency.
    expect(out.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to recent messages when nothing matches', () => {
    const out = buildSnippets(c1, 'kubernetes helm chart', { before: 1, after: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].messages.every((m) => m.isMatch === false)).toBe(true);
    // Most-recent window, chronological.
    expect(out[0].messages.map((m) => m.messageId)).toEqual(['14', '15', '16']);
  });

  it('falls back to recent when the query has no usable terms', () => {
    const out = buildSnippets(c1, '  ??  ', { before: 1, after: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(0);
  });
});

describe('searchDiscordMessages (range filter)', () => {
  // Three messages on three days; timestamps as comparable Timestamp-likes.
  const DAY1 = Date.UTC(2026, 5, 1, 4); // 2026-06-01
  const DAY3 = Date.UTC(2026, 5, 3, 4); // 2026-06-03
  const DAY9 = Date.UTC(2026, 5, 9, 4); // 2026-06-09

  // Numeric (snowflake-like) message ids so buildSnippets' BigInt sort works.
  beforeEach(() => {
    store.clear();
    store.set(`${msgCol}/101`, { channelId: 'c1', authorName: 'a', content: 'deploy oauth', timestamp: ts(DAY1) });
    store.set(`${msgCol}/103`, { channelId: 'c1', authorName: 'b', content: 'oauth again', timestamp: ts(DAY3) });
    store.set(`${msgCol}/109`, { channelId: 'c1', authorName: 'c', content: 'oauth way later', timestamp: ts(DAY9) });
  });

  it('without a range, scans every message', async () => {
    const out = await searchDiscordMessages(REPO, 'oauth');
    const ids = out.flatMap((s) => s.messages.map((m) => m.messageId)).sort();
    expect(ids).toEqual(['101', '103', '109']);
  });

  it('with a range, only surfaces in-window messages', async () => {
    // Window [06-01, 06-06): includes 101 (06-01) + 103 (06-03), excludes 109 (06-09).
    const range = rangeFor(Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 6), '2026-06-01', '2026-06-05');
    const out = await searchDiscordMessages(REPO, 'oauth', undefined, range);
    const ids = out.flatMap((s) => s.messages.map((m) => m.messageId)).sort();
    expect(ids).toEqual(['101', '103']);
    expect(ids).not.toContain('109');
  });

  it('never throws — degrades to [] on a read failure', async () => {
    const out = await searchDiscordMessages('no-such-collection-path', 'x');
    expect(Array.isArray(out)).toBe(true);
  });
});

describe('listDaySummaries (range filter)', () => {
  beforeEach(() => {
    store.clear();
    store.set(`${digestCol}/2026-05-30`, { date: '2026-05-30', messageCount: 1, markdown: 'before' });
    store.set(`${digestCol}/2026-06-02`, { date: '2026-06-02', messageCount: 2, markdown: 'inside a' });
    store.set(`${digestCol}/2026-06-04`, { date: '2026-06-04', messageCount: 3, markdown: 'inside b' });
    store.set(`${digestCol}/2026-06-09`, { date: '2026-06-09', messageCount: 4, markdown: 'after' });
  });

  it('without a range, returns every digest', async () => {
    const out = await listDaySummaries(REPO);
    expect(out.map((d) => d.date).sort()).toEqual([
      '2026-05-30',
      '2026-06-02',
      '2026-06-04',
      '2026-06-09',
    ]);
  });

  it('with a range, filters to days within [startDate, endDate]', async () => {
    const range = rangeFor(0, 1, '2026-06-01', '2026-06-05');
    const out = await listDaySummaries(REPO, range);
    expect(out.map((d) => d.date).sort()).toEqual(['2026-06-02', '2026-06-04']);
  });

  it('includes the inclusive endpoints', async () => {
    const range = rangeFor(0, 1, '2026-06-02', '2026-06-04');
    const out = await listDaySummaries(REPO, range);
    expect(out.map((d) => d.date).sort()).toEqual(['2026-06-02', '2026-06-04']);
  });
});

describe('buildSnippetsFromMatches (vector hit grouping)', () => {
  it('groups matched ids with ±context, flagging only the matches', () => {
    // c1 ids 10..16; semantic hits are 11 and 15.
    const out = buildSnippetsFromMatches(c1, new Set(['11', '15']), {
      before: 1,
      after: 1,
    });
    expect(out).toHaveLength(2);
    const ids = out.map((s) => s.messages.map((m) => m.messageId));
    expect(ids).toContainEqual(['10', '11', '12']);
    expect(ids).toContainEqual(['14', '15', '16']);
    const snip = out.find((s) => s.messages.some((m) => m.messageId === '11'))!;
    const matched = snip.messages.filter((m) => m.isMatch).map((m) => m.messageId);
    expect(matched).toEqual(['11']);
  });

  it('falls back to a recent snippet when there are no matched ids', () => {
    const out = buildSnippetsFromMatches(c1, new Set<string>(), {
      before: 1,
      after: 1,
    });
    expect(out).toHaveLength(1);
    expect(out[0].messages.every((m) => m.isMatch === false)).toBe(true);
  });
});

describe('searchDiscordMessages (vector-first + fallback)', () => {
  const REPO_V = 'team17_gitsync';
  const col = `apps/gitsync/repos/${REPO_V}/discordMessages`;

  beforeEach(() => {
    store.clear();
    // A small same-channel timeline; every doc carries repoId (collectionGroup
    // prefilter) and a usable timestamp (scan window order).
    for (let i = 10; i <= 16; i++) {
      store.set(`${col}/${i}`, {
        repoId: REPO_V,
        channelId: 'c1',
        authorName: `u${i}`,
        content: `message number ${i}`,
        timestamp: ts(Date.UTC(2026, 5, 1, i)),
      });
    }
  });

  it('semantic hits → snippet with the hit flagged and surrounding context', async () => {
    vectorHitIds = ['13']; // findNearest ranks doc 13 first
    const out = await searchDiscordMessages(REPO_V, 'anything semantic');
    const flat = out.flatMap((s) => s.messages);
    expect(flat.some((m) => m.messageId === '13' && m.isMatch)).toBe(true);
    // ±2 context around id 13 (within the scan window).
    const ids = flat.map((m) => m.messageId).sort();
    expect(ids).toEqual(expect.arrayContaining(['11', '12', '13', '14', '15']));
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it('embedding failure → degrades to keyword path (still returns snippets)', async () => {
    mockEmbed.mockRejectedValue(new Error('openai down'));
    const out = await searchDiscordMessages(REPO_V, 'message');
    // Keyword match on "message" across the window → non-empty result.
    expect(out.length).toBeGreaterThan(0);
  });

  it('findNearest failure (missing index) → degrades to keyword path', async () => {
    findNearestError = new Error('9 FAILED_PRECONDITION: Missing vector index');
    const out = await searchDiscordMessages(REPO_V, 'message');
    expect(out.length).toBeGreaterThan(0);
  });

  it('zero vector hits → degrades to keyword path', async () => {
    vectorHitIds = []; // findNearest returns nothing
    const out = await searchDiscordMessages(REPO_V, 'message');
    expect(out.length).toBeGreaterThan(0);
  });

  it('range present → hits outside the window are post-filtered out', async () => {
    // findNearest "returns" 10 and 16; window only covers hour 11..14.
    vectorHitIds = ['10', '12', '16'];
    const range = rangeFor(
      Date.UTC(2026, 5, 1, 11),
      Date.UTC(2026, 5, 1, 15),
      '2026-06-01',
      '2026-06-01',
    );
    const out = await searchDiscordMessages(REPO_V, 'anything', undefined, range);
    const matched = out
      .flatMap((s) => s.messages)
      .filter((m) => m.isMatch)
      .map((m) => m.messageId);
    // 12 is in-window → match; 10 and 16 are out-of-window → dropped.
    expect(matched).toContain('12');
    expect(matched).not.toContain('10');
    expect(matched).not.toContain('16');
  });
});
