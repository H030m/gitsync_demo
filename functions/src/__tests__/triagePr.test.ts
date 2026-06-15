// Unit tests for the triagePr flow (pure logic — summary + reviewers + tags).
//
// Boundary mocks:
//   - firebase-functions/v2 → logger no-op.
//   - ../services/githubClient → listPullRequestFiles + listCommitsForPath
//     return canned data per test.
//   - ../tools/assignTools → readTeamState returns a synthetic roster.
//   - ../config → getOpenAI with mocked chat.completions.create.
//   - ../admin → fake Firestore for recentTriageLoad's pullRequests query.

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockListFiles = jest.fn();
const mockListCommitsForPath = jest.fn();
jest.mock('../services/githubClient', () => ({
  listPullRequestFiles: (...args: unknown[]) => mockListFiles(...args),
  listCommitsForPath: (...args: unknown[]) => mockListCommitsForPath(...args),
}));

const mockReadTeamState = jest.fn();
jest.mock('../tools/assignTools', () => ({
  readTeamState: (...args: unknown[]) => mockReadTeamState(...args),
}));

const mockChatCreate = jest.fn();
jest.mock('../config', () => ({
  getOpenAI: () => ({ chat: { completions: { create: mockChatCreate } } }),
  MODELS: { reasoning: 'gpt-4o', fast: 'gpt-4o-mini', embedding: 'text-embedding-3-small' },
  openaiKey: { value: () => 'k' },
}));

// ---- Fake Firestore (for recentTriageLoad's pullRequests query) ----------
// Single mutable state: the list of pullRequest docs the query should return.
// Tests that don't care leave it empty → recentTriageLoad returns empty load,
// matching the pre-06-13 baseline behavior. We ALSO record the args the
// producer passes into .where()/.limit() so AC #5 (14d window AND 50-PR cap)
// has a real contract assertion, not just "the call shape compiled".
const fakePrDocs: { data: () => Record<string, unknown> }[] = [];
let throwOnPrQuery = false;
const queryCalls: {
  collection: string | null;
  where: Array<[string, string, unknown]>;
  orderBy: Array<[string, string]>;
  limit: number | null;
} = { collection: null, where: [], orderBy: [], limit: null };

const fakeQuery = {
  where(field: string, op: string, value: unknown) {
    queryCalls.where.push([field, op, value]);
    return fakeQuery;
  },
  orderBy(field: string, dir: string) {
    queryCalls.orderBy.push([field, dir]);
    return fakeQuery;
  },
  limit(n: number) {
    queryCalls.limit = n;
    return fakeQuery;
  },
  async get() {
    if (throwOnPrQuery) throw new Error('firestore down');
    return { docs: fakePrDocs };
  },
};
const fakeDb = {
  collection(path: string) {
    queryCalls.collection = path;
    return fakeQuery;
  },
};
jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

import {
  computeRiskTags,
  pickReviewers,
  recentTriageLoad,
  triagePr,
  type RecentTriageLoad,
} from '../flows/triagePr';

const BASE_INPUT = {
  repoId: 'octocat_hello',
  prNumber: 42,
  prAuthorLogin: 'alice',
  title: 'Add login screen',
  body: 'Hooks up the login flow.',
  owner: 'octocat',
  repo: 'hello',
  accessToken: 'token',
};

function file(
  filename: string,
  additions = 10,
  deletions = 5,
  patch: string | null = '@@ -1 +1 @@\n-old\n+new',
) {
  return { filename, additions, deletions, status: 'modified', patch };
}

beforeEach(() => {
  mockListFiles.mockReset();
  mockListCommitsForPath.mockReset();
  mockReadTeamState.mockReset();
  mockChatCreate
    .mockReset()
    .mockResolvedValue({ choices: [{ message: { content: 'Summary line.' } }] });
  fakePrDocs.length = 0;
  throwOnPrQuery = false;
  queryCalls.collection = null;
  queryCalls.where.length = 0;
  queryCalls.orderBy.length = 0;
  queryCalls.limit = null;
});

describe('computeRiskTags', () => {
  it('flags large-diff above the 300 line threshold', () => {
    expect(computeRiskTags([file('a.ts', 200, 200)])).toContain('large-diff');
    expect(computeRiskTags([file('a.ts', 150, 100)])).not.toContain('large-diff');
  });

  it('flags touches-functions for any functions/ path', () => {
    expect(computeRiskTags([file('functions/src/x.ts', 1, 0)])).toContain(
      'touches-functions',
    );
    expect(computeRiskTags([file('lib/x.dart', 1, 0)])).not.toContain(
      'touches-functions',
    );
  });

  it('flags touches-rules for firestore.rules / firestore.indexes.json', () => {
    expect(computeRiskTags([file('firestore.rules', 1, 0)])).toContain(
      'touches-rules',
    );
    expect(
      computeRiskTags([file('firestore.indexes.json', 1, 0)]),
    ).toContain('touches-rules');
  });

  it('flags touches-schema for migrations/ or schema/ paths', () => {
    expect(computeRiskTags([file('db/migrations/001.sql', 1, 0)])).toContain(
      'touches-schema',
    );
    expect(computeRiskTags([file('schema/user.proto', 1, 0)])).toContain(
      'touches-schema',
    );
  });

  it('stacks multiple tags when all conditions hold', () => {
    const tags = computeRiskTags([
      file('functions/src/x.ts', 500, 0),
      file('firestore.rules', 1, 0),
    ]);
    expect(tags).toEqual(
      expect.arrayContaining(['large-diff', 'touches-functions', 'touches-rules']),
    );
  });
});

describe('triagePr', () => {
  it('returns top 2 reviewers, excludes PR author, ranks by file-history score', async () => {
    mockListFiles.mockResolvedValue([
      file('lib/login.dart', 100, 50),
      file('lib/auth.dart', 80, 20),
    ]);
    // bob appears recently in BOTH files → highest score
    // carol appears once, rank 0 in auth.dart
    // alice (PR author) must be excluded even if she appears
    mockListCommitsForPath.mockImplementation(
      async (_o: string, _r: string, _t: string, path: string) => {
        if (path === 'lib/login.dart') {
          return [
            { sha: 's1', authorLogin: 'bob', committedAt: '2026-06-01' },
            { sha: 's2', authorLogin: 'alice', committedAt: '2026-05-28' },
          ];
        }
        if (path === 'lib/auth.dart') {
          return [
            { sha: 's3', authorLogin: 'bob', committedAt: '2026-06-02' },
            { sha: 's4', authorLogin: 'carol', committedAt: '2026-05-25' },
            { sha: 's5', authorLogin: 'dave', committedAt: '2026-04-01' },
          ];
        }
        return [];
      },
    );
    mockReadTeamState.mockResolvedValue([
      { userId: 'uA', name: 'Alice', githubLogin: 'alice', discordUserId: '1', activeIssueCount: 0, expertiseTags: [], lastActiveAt: null },
      { userId: 'uB', name: 'Bob', githubLogin: 'bob', discordUserId: '2', activeIssueCount: 3, expertiseTags: [], lastActiveAt: null },
      { userId: 'uC', name: 'Carol', githubLogin: 'carol', discordUserId: '3', activeIssueCount: 1, expertiseTags: [], lastActiveAt: null },
      { userId: 'uD', name: 'Dave', githubLogin: 'dave', discordUserId: '4', activeIssueCount: 2, expertiseTags: [], lastActiveAt: null },
    ]);

    const result = await triagePr(BASE_INPUT);

    expect(result.summary).toBe('Summary line.');
    expect(result.recommendedReviewers.map((r) => r.userId)).toEqual(['uB', 'uC']);
    expect(result.recommendedReviewers[0]).toMatchObject({
      userId: 'uB',
      githubLogin: 'bob',
      discordUserId: '2',
    });
  });

  it('drops candidates whose githubLogin is not in the repo roster', async () => {
    mockListFiles.mockResolvedValue([file('a.ts')]);
    mockListCommitsForPath.mockResolvedValue([
      { sha: 's1', authorLogin: 'externalContributor', committedAt: '2026-06-01' },
      { sha: 's2', authorLogin: 'bob', committedAt: '2026-05-25' },
    ]);
    mockReadTeamState.mockResolvedValue([
      { userId: 'uB', name: 'Bob', githubLogin: 'bob', discordUserId: '2', activeIssueCount: 0, expertiseTags: [], lastActiveAt: null },
    ]);

    const result = await triagePr(BASE_INPUT);

    expect(result.recommendedReviewers.map((r) => r.userId)).toEqual(['uB']);
  });

  it('breaks score ties by lower activeIssueCount', async () => {
    // 2 files; bob appears as rank-0 sole committer in one, carol in the
    // other → identical scores (1 each). Tiebreak must prefer carol (lower load).
    mockListFiles.mockResolvedValue([file('a.ts'), file('b.ts')]);
    mockListCommitsForPath
      .mockResolvedValueOnce([{ sha: 's1', authorLogin: 'bob', committedAt: '2026-06-01' }])
      .mockResolvedValueOnce([{ sha: 's2', authorLogin: 'carol', committedAt: '2026-06-01' }]);
    mockReadTeamState.mockResolvedValue([
      { userId: 'uB', name: 'Bob', githubLogin: 'bob', discordUserId: '2', activeIssueCount: 5, expertiseTags: [], lastActiveAt: null },
      { userId: 'uC', name: 'Carol', githubLogin: 'carol', discordUserId: '3', activeIssueCount: 1, expertiseTags: [], lastActiveAt: null },
    ]);

    const result = await triagePr(BASE_INPUT);

    expect(result.recommendedReviewers.map((r) => r.userId)).toEqual(['uC', 'uB']);
  });

  it('listPullRequestFiles failure → empty result, never throws', async () => {
    mockListFiles.mockRejectedValue(new Error('boom'));
    const result = await triagePr(BASE_INPUT);
    expect(result).toEqual({
      summary: '',
      recommendedReviewers: [],
      reviewerScores: [],
      riskTags: [],
    });
  });

  it('OpenAI failure → empty summary, but reviewers + tags still returned', async () => {
    mockListFiles.mockResolvedValue([file('functions/src/x.ts', 400, 0)]);
    mockListCommitsForPath.mockResolvedValue([
      { sha: 's1', authorLogin: 'bob', committedAt: '2026-06-01' },
    ]);
    mockReadTeamState.mockResolvedValue([
      { userId: 'uB', name: 'Bob', githubLogin: 'bob', discordUserId: '2', activeIssueCount: 0, expertiseTags: [], lastActiveAt: null },
    ]);
    mockChatCreate.mockRejectedValue(new Error('openai down'));

    const result = await triagePr(BASE_INPUT);

    expect(result.summary).toBe('');
    expect(result.recommendedReviewers.map((r) => r.userId)).toEqual(['uB']);
    expect(result.riskTags).toEqual(
      expect.arrayContaining(['large-diff', 'touches-functions']),
    );
  });

  it('per-file history failure is skipped, not fatal', async () => {
    mockListFiles.mockResolvedValue([file('a.ts'), file('b.ts')]);
    mockListCommitsForPath
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce([
        { sha: 's', authorLogin: 'bob', committedAt: '2026-06-01' },
      ]);
    mockReadTeamState.mockResolvedValue([
      { userId: 'uB', name: 'Bob', githubLogin: 'bob', discordUserId: '2', activeIssueCount: 0, expertiseTags: [], lastActiveAt: null },
    ]);

    const result = await triagePr(BASE_INPUT);

    expect(result.recommendedReviewers.map((r) => r.userId)).toEqual(['uB']);
  });

  it('no candidates → empty reviewers, no throw', async () => {
    mockListFiles.mockResolvedValue([file('a.ts')]);
    mockListCommitsForPath.mockResolvedValue([]);
    mockReadTeamState.mockResolvedValue([]);

    const result = await triagePr(BASE_INPUT);

    expect(result.recommendedReviewers).toEqual([]);
    expect(result.reviewerScores).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Workload-aware (A+D) — 06-13. These exercise pickReviewers directly with
// synthetic load. Keeping pickReviewers Firestore-free means we can pass any
// RecentTriageLoad shape without an emulator.
// ---------------------------------------------------------------------------

const ROSTER = [
  { userId: 'uB', name: 'Bob', githubLogin: 'bob', discordUserId: '2', activeIssueCount: 0, expertiseTags: [], lastActiveAt: null },
  { userId: 'uC', name: 'Carol', githubLogin: 'carol', discordUserId: '3', activeIssueCount: 0, expertiseTags: [], lastActiveAt: null },
  { userId: 'uD', name: 'Dave', githubLogin: 'dave', discordUserId: '4', activeIssueCount: 0, expertiseTags: [], lastActiveAt: null },
];

const EMPTY_LOAD: RecentTriageLoad = {
  picksByUserId: new Map(),
  recentReviewerSets: [],
};

describe('pickReviewers — workload-aware (A+D)', () => {
  it('tied file-history scores: candidate with lower recent triage load wins slot 1', async () => {
    // bob and carol both at rawScore=1 — but bob has 3 recent triage picks,
    // carol has 0 → carol's loadPenalty is 1, bob's is 1/(1+0.3*3)=0.526 →
    // carol gets slot 1.
    mockReadTeamState.mockResolvedValue(ROSTER);
    const scoreByLogin = new Map<string, number>([
      ['bob', 1],
      ['carol', 1],
    ]);
    const load: RecentTriageLoad = {
      picksByUserId: new Map([['uB', 3]]),
      recentReviewerSets: [],
    };

    const { reviewers, scores } = await pickReviewers(
      'repo1',
      'alice',
      scoreByLogin,
      load,
    );

    expect(reviewers.map((r) => r.userId)).toEqual(['uC', 'uB']);
    expect(scores[0].slot).toBe(1);
    expect(scores[0].userId).toBe('uC');
    expect(scores[1].slot).toBe(2);
  });

  it('strong-but-busy still beats weak-but-idle when the score gap × penalty math says so', async () => {
    // bob: rawScore=2, load=3 → penalty=1/1.9≈0.526, finalScore≈1.053
    // carol: rawScore=0.6, load=0 → penalty=1, finalScore=0.6
    // bob still wins.
    mockReadTeamState.mockResolvedValue(ROSTER);
    const scoreByLogin = new Map<string, number>([
      ['bob', 2],
      ['carol', 0.6],
    ]);
    const load: RecentTriageLoad = {
      picksByUserId: new Map([['uB', 3]]),
      recentReviewerSets: [],
    };

    const { reviewers, scores } = await pickReviewers(
      'repo1',
      'alice',
      scoreByLogin,
      load,
    );

    expect(reviewers[0].userId).toBe('uB');
    // Numeric assertion: bob's finalScore > carol's finalScore.
    expect(scores[0].finalScore).toBeGreaterThan(scores[1].finalScore);
    expect(scores[0].finalScore).toBeCloseTo(2 * (1 / (1 + 0.3 * 3)), 5);
    expect(scores[1].finalScore).toBeCloseTo(0.6, 5);
  });

  it('freshness on slot 2: prefers a candidate not in any of the last-5 reviewer sets', async () => {
    // bob is the runaway expert. Both carol and dave are viable for slot 2,
    // but carol was a reviewer on each of the synthetic recent PRs → slot 2
    // must go to dave (fresh face), not carol (next-by-score).
    mockReadTeamState.mockResolvedValue(ROSTER);
    const scoreByLogin = new Map<string, number>([
      ['bob', 3],
      ['carol', 1],
      ['dave', 0.8],
    ]);
    const load: RecentTriageLoad = {
      picksByUserId: new Map(),
      recentReviewerSets: [new Set(['uC']), new Set(['uC']), new Set(['uC'])],
    };

    const { reviewers } = await pickReviewers(
      'repo1',
      'alice',
      scoreByLogin,
      load,
    );

    expect(reviewers.map((r) => r.userId)).toEqual(['uB', 'uD']);
  });

  it('freshness empties pool → falls back to next-highest finalScore', async () => {
    // Both runners-up appear in recent reviewer sets → freshness filter
    // returns nothing → slot 2 falls back to next-by-finalScore (carol).
    mockReadTeamState.mockResolvedValue(ROSTER);
    const scoreByLogin = new Map<string, number>([
      ['bob', 3],
      ['carol', 1],
      ['dave', 0.8],
    ]);
    const load: RecentTriageLoad = {
      picksByUserId: new Map(),
      recentReviewerSets: [new Set(['uC', 'uD'])],
    };

    const { reviewers } = await pickReviewers(
      'repo1',
      'alice',
      scoreByLogin,
      load,
    );

    expect(reviewers.map((r) => r.userId)).toEqual(['uB', 'uC']);
  });

  it('slot-2 floor: when only one above-floor candidate exists, returns 1 reviewer (no rubber stamp)', async () => {
    // bob: rawScore=2 (clears the floor). carol: rawScore=0.3 (below 0.5 floor).
    // → slot 2 stays empty.
    mockReadTeamState.mockResolvedValue(ROSTER);
    const scoreByLogin = new Map<string, number>([
      ['bob', 2],
      ['carol', 0.3],
    ]);

    const { reviewers, scores } = await pickReviewers(
      'repo1',
      'alice',
      scoreByLogin,
      EMPTY_LOAD,
    );

    expect(reviewers.map((r) => r.userId)).toEqual(['uB']);
    expect(scores).toHaveLength(1);
    expect(scores[0].slot).toBe(1);
  });

  it('empty load = old behavior (still picks top-2 when both clear the floor)', async () => {
    mockReadTeamState.mockResolvedValue(ROSTER);
    const scoreByLogin = new Map<string, number>([
      ['bob', 2],
      ['carol', 1],
    ]);

    const { reviewers } = await pickReviewers(
      'repo1',
      'alice',
      scoreByLogin,
      EMPTY_LOAD,
    );

    expect(reviewers.map((r) => r.userId)).toEqual(['uB', 'uC']);
  });

  it('active-issue count folds into load via ACTIVE_ISSUE_LOAD_WEIGHT', async () => {
    // Both at rawScore=1, no recent picks — but bob has 4 open task
    // assignments (load=4*0.25=1) and carol has 0. Carol wins.
    mockReadTeamState.mockResolvedValue([
      { ...ROSTER[0], activeIssueCount: 4 },
      ROSTER[1],
    ]);
    const scoreByLogin = new Map<string, number>([
      ['bob', 1],
      ['carol', 1],
    ]);

    const { reviewers } = await pickReviewers(
      'repo1',
      'alice',
      scoreByLogin,
      EMPTY_LOAD,
    );

    expect(reviewers[0].userId).toBe('uC');
  });
});

describe('recentTriageLoad — windowing', () => {
  it('returns empty load when the Firestore query throws', async () => {
    throwOnPrQuery = true;
    const load = await recentTriageLoad('repo1');
    expect(load.picksByUserId.size).toBe(0);
    expect(load.recentReviewerSets).toEqual([]);
  });

  it('aggregates picks across the full window, slices reviewer sets to FRESHNESS_WINDOW_PRS', async () => {
    // 7 fake "recent triaged PRs" (the fake query layer ignores the .where/
    // .orderBy/.limit chain, so we just hand back what we put in). picksByUserId
    // must sum across all 7; recentReviewerSets must only carry the first 5.
    const reviewerArrays: string[][] = [
      ['uA', 'uB'],
      ['uA'],
      ['uB', 'uC'],
      ['uC'],
      ['uA'],
      ['uD'], // 6th — must NOT appear in recentReviewerSets
      ['uE'], // 7th — must NOT appear in recentReviewerSets
    ];
    for (const arr of reviewerArrays) {
      fakePrDocs.push({ data: () => ({ recommendedReviewers: arr }) });
    }

    const load = await recentTriageLoad('repo1');

    // Picks aggregate over all 7 docs.
    expect(load.picksByUserId.get('uA')).toBe(3);
    expect(load.picksByUserId.get('uB')).toBe(2);
    expect(load.picksByUserId.get('uC')).toBe(2);
    expect(load.picksByUserId.get('uD')).toBe(1);
    expect(load.picksByUserId.get('uE')).toBe(1);
    // Reviewer sets are sliced to the freshness window (5).
    expect(load.recentReviewerSets).toHaveLength(5);
    expect(load.recentReviewerSets[0]).toEqual(new Set(['uA', 'uB']));
    expect(load.recentReviewerSets[4]).toEqual(new Set(['uA']));
    // uD / uE should NOT be in any of the freshness sets.
    for (const s of load.recentReviewerSets) {
      expect(s.has('uD')).toBe(false);
      expect(s.has('uE')).toBe(false);
    }
  });

  it('queries the right collection with a 14d window AND a 50-PR cap (AC #5 contract)', async () => {
    const before = Date.now();
    await recentTriageLoad('octocat_hello');

    // Collection path mirrors the schema in ARCHITECTURE §2.1.
    expect(queryCalls.collection).toBe(
      'apps/gitsync/repos/octocat_hello/pullRequests',
    );
    // Single range filter, on `triagedAt` with `>` (NOT `!=` — Firestore
    // can't index that; see triagePr.ts NOTE).
    expect(queryCalls.where).toHaveLength(1);
    const [field, op, value] = queryCalls.where[0];
    expect(field).toBe('triagedAt');
    expect(op).toBe('>');
    // `since = now - 14d`. Allow a 1s wobble for the time between recording
    // `before` and the actual query construction.
    const since = (value as Date).getTime();
    const expected = before - 14 * 86_400_000;
    expect(Math.abs(since - expected)).toBeLessThan(1_000);
    // Newest-first + capped to LOAD_RECENT_PR_CAP=50.
    expect(queryCalls.orderBy).toEqual([['triagedAt', 'desc']]);
    expect(queryCalls.limit).toBe(50);
  });

  it('tolerates docs with no recommendedReviewers field', async () => {
    fakePrDocs.push({ data: () => ({}) });
    fakePrDocs.push({
      data: () => ({ recommendedReviewers: ['uA'] }),
    });
    const load = await recentTriageLoad('repo1');
    expect(load.picksByUserId.get('uA')).toBe(1);
    expect(load.recentReviewerSets).toHaveLength(2);
    expect(load.recentReviewerSets[0]).toEqual(new Set());
  });
});
