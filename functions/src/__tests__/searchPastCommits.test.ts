// Unit tests for searchPastCommits (dailyIntel.ts) — vector-first commit search
// with a keyword + recency fallback. Asserts the return shape stays DayCommit[]
// on both paths and that every failure degrades gracefully.
//
// Boundary mocks:
//   - firebase-functions/v2 → logger no-op.
//   - ../admin → fake Firestore (collection/where/findNearest + orderBy/limit/get).
//   - ../tools/embedding → embed() stubbed.
//   - ../flows/discordDailyDigest → taipeiDayBounds stub (imported transitively).

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../flows/discordDailyDigest', () => ({
  taipeiDayBounds: (date: string) => ({
    start: { toMillis: () => Date.parse(`${date}T00:00:00Z`) },
    end: { toMillis: () => Date.parse(`${date}T00:00:00Z`) + 86_400_000 },
  }),
}));

const store = new Map<string, Record<string, unknown>>();
let findNearestError: Error | null = null;
let vectorHitIds: string[] = [];

function childDocsOf(colPath: string): Array<[string, Record<string, unknown>]> {
  return [...store.entries()].filter(
    ([p]) =>
      p.startsWith(`${colPath}/`) &&
      p.slice(colPath.length + 1).indexOf('/') === -1,
  );
}

interface Clause {
  field: string;
  op: string;
  value: unknown;
}

function makeQuery(colPath: string, clauses: Clause[]) {
  const filtered = () =>
    childDocsOf(colPath).filter(([, d]) =>
      clauses.every((c) => (c.op === '==' ? d[c.field] === c.value : true)),
    );
  const q = {
    where(field: string, op: string, value: unknown) {
      return makeQuery(colPath, [...clauses, { field, op, value }]);
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
          const present = new Map(
            filtered().map(([p, d]) => [p.split('/').pop() as string, d]),
          );
          // Firestore caps results at the findNearest `limit` — model that.
          const cap = opts?.limit ?? Infinity;
          const docs = vectorHitIds
            .filter((id) => present.has(id))
            .slice(0, cap)
            .map((id) => ({ id, data: () => present.get(id)! }));
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
          data: () => d,
        })),
      };
    },
  };
  return q;
}

const fakeDb = {
  collection: (path: string) => makeQuery(path, []),
};

jest.mock('../admin', () => ({ db: fakeDb }));

const mockEmbed = jest.fn();
jest.mock('../tools/embedding', () => ({
  embed: (...args: unknown[]) => mockEmbed(...args),
}));

import { searchPastCommits } from '../tools/dailyIntel';

const REPO = 'octocat_hello';
const col = `apps/gitsync/repos/${REPO}/commits`;

function seedCommit(sha: string, message: string, extra: Record<string, unknown> = {}) {
  store.set(`${col}/${sha}`, {
    repoId: REPO,
    message,
    author: { login: 'alice', name: 'Alice' },
    additions: 1,
    deletions: 0,
    committedAt: { toMillis: () => 0 },
    ...extra,
  });
}

beforeEach(() => {
  store.clear();
  findNearestError = null;
  vectorHitIds = [];
  mockEmbed.mockReset().mockResolvedValue(new Array(1536).fill(0));
});

describe('searchPastCommits vector-first', () => {
  it('returns DayCommit[] from semantic hits (no keyword scan needed)', async () => {
    seedCommit('sha1', 'add OAuth login flow');
    seedCommit('sha2', 'unrelated change');
    vectorHitIds = ['sha1'];

    const out = await searchPastCommits(REPO, 'authentication');

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sha: 'sha1',
      message: 'add OAuth login flow',
      authorLogin: 'alice',
      authorName: 'Alice',
      linkedTaskIds: [],
    });
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it('respects the limit cap on vector hits', async () => {
    for (let i = 0; i < 5; i++) seedCommit(`s${i}`, `commit ${i}`);
    vectorHitIds = ['s0', 's1', 's2', 's3', 's4'];

    const out = await searchPastCommits(REPO, 'topic', 2);
    expect(out).toHaveLength(2);
  });
});

describe('searchPastCommits keyword fallback', () => {
  it('embedding failure → keyword scoring, still DayCommit[]', async () => {
    seedCommit('sha1', 'fix the OAuth bug');
    seedCommit('sha2', 'tweak CSS');
    mockEmbed.mockRejectedValue(new Error('openai down'));

    const out = await searchPastCommits(REPO, 'oauth');
    expect(out.map((c) => c.sha)).toContain('sha1');
    expect(out[0].message).toBe('fix the OAuth bug');
  });

  it('findNearest failure (missing index) → keyword scoring', async () => {
    seedCommit('sha1', 'refactor the oauth handler');
    seedCommit('sha2', 'docs only');
    findNearestError = new Error('9 FAILED_PRECONDITION: Missing vector index');

    const out = await searchPastCommits(REPO, 'oauth');
    expect(out.map((c) => c.sha)).toContain('sha1');
  });

  it('zero vector hits → keyword scoring', async () => {
    seedCommit('sha1', 'add oauth scopes');
    vectorHitIds = []; // findNearest returns nothing

    const out = await searchPastCommits(REPO, 'oauth');
    expect(out.map((c) => c.sha)).toContain('sha1');
  });

  it('empty query → recent commits, no embed call', async () => {
    seedCommit('sha1', 'anything');
    const out = await searchPastCommits(REPO, '   ');
    expect(out).toHaveLength(1);
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});
