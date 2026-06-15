// Unit tests for the getCommitGraph callable + assembleGraph (pure topology
// assembly). Boundary mocks per testing-guidelines: onCall → raw handler,
// ../admin → in-memory fake, ../services/githubClient → jest.mock.

class FakeHttpsError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'HttpsError';
  }
}

jest.mock('firebase-functions/v2/https', () => ({
  onCall: (_opts: unknown, handler: unknown) => handler,
  HttpsError: FakeHttpsError,
}));
jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ---- Fake Firestore ---------------------------------------------------------

const store = new Map<string, Record<string, unknown>>();
const setSpy = jest.fn();
const createSpy = jest.fn();
// Paths whose create() should reject with a non-ALREADY_EXISTS error (drives
// the "a create failure does not fail the call" test). Cleared each test.
const createFailPaths = new Set<string>();

const fakeDb = {
  doc: (path: string) => ({
    path,
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    async set(data: Record<string, unknown>) {
      store.set(path, data);
      setSpy(path, data);
    },
    // Mirrors Firestore create(): rejects with ALREADY_EXISTS (gRPC code 6)
    // when the doc already exists — drives the first-seen-wins sync path.
    async create(data: Record<string, unknown>) {
      createSpy(path, data);
      if (createFailPaths.has(path)) {
        throw new Error('boom: create failed');
      }
      if (store.has(path)) {
        const err = new Error('ALREADY_EXISTS') as Error & { code: number };
        err.code = 6;
        throw err;
      }
      store.set(path, data);
    },
  }),
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

// The D7 sync step needs Timestamp.fromDate + FieldValue.serverTimestamp.
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__serverTimestamp__',
  },
  Timestamp: {
    fromDate: (d: Date) => ({ __ms__: d.getTime(), toMillis: () => d.getTime() }),
  },
}));

// The flow only needs taipeiRangeBounds from dailyIntel — mock the module so
// its transitive imports (discordSearch, assignTools) stay out of this test.
jest.mock('../tools/dailyIntel', () => ({
  taipeiRangeBounds: (startDate: string, endDate: string) => ({
    start: { toDate: () => new Date(`${startDate}T00:00:00+08:00`) },
    end: { toDate: () => new Date(`${endDate}T24:00:00+08:00`) },
  }),
}));

const mockFetchCommitGraph = jest.fn();
jest.mock('../services/githubClient', () => ({
  fetchCommitGraph: (...args: unknown[]) => mockFetchCommitGraph(...args),
}));

import { getCommitGraph } from '../handlers/getCommitGraph';
import { assembleGraph } from '../flows/getCommitGraph';
import type { GraphBranchRaw } from '../services/githubClient';

type Handler = (req: {
  auth: { uid: string } | null;
  data: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;
const handler = getCommitGraph as unknown as Handler;

// ---- Fixtures ---------------------------------------------------------------

const REPO = 'team17_gitsync';

function rawCommit(
  sha: string,
  parents: string[],
  committedAt: string,
  overrides: Partial<GraphBranchRaw['commits'][number]> = {},
) {
  return {
    sha,
    message: `commit ${sha}`,
    committedAt,
    parents,
    authorLogin: 'alice-dev',
    authorName: 'Alice',
    avatarUrl: 'https://avatars.example/a.png',
    associatedPrNumber: null,
    ...overrides,
  };
}

// main: m1 ── m2 ──────── m3 (merge of feature/x #12)
//         └─ f1 ── f2 ──┘
const M1 = rawCommit('m1', ['m0-offscreen'], '2026-06-01T01:00:00Z');
const M2 = rawCommit('m2', ['m1'], '2026-06-02T01:00:00Z');
const F1 = rawCommit('f1', ['m1'], '2026-06-02T02:00:00Z');
const F2 = rawCommit('f2', ['f1'], '2026-06-03T01:00:00Z');
const M3 = rawCommit('m3', ['m2', 'f2'], '2026-06-04T01:00:00Z', {
  message: 'Merge pull request #12 from team17/feature-x',
});

const BRANCHES: GraphBranchRaw[] = [
  {
    name: 'main',
    tipSha: 'm3',
    isDefault: true,
    commits: [M3, M2, F2, F1, M1],
    truncated: false,
  },
  {
    name: 'feature/x',
    tipSha: 'f2',
    isDefault: false,
    commits: [F2, F1, M1],
    truncated: false,
  },
];

beforeEach(() => {
  store.clear();
  setSpy.mockClear();
  createSpy.mockClear();
  createFailPaths.clear();
  mockFetchCommitGraph.mockReset();
  store.set(`apps/gitsync/repos/${REPO}`, { name: 'team17/gitsync' });
  store.set('apps/gitsync/users/u1', { githubAccessToken: 'tok' });
});

// ---- assembleGraph (pure) ----------------------------------------------------

describe('assembleGraph', () => {
  it('dedupes, attributes primary branches via first-parent walks, labels merges', () => {
    const res = assembleGraph(BRANCHES);

    expect(res.commits.map((c) => c.sha)).toEqual(['m3', 'f2', 'f1', 'm2', 'm1']);

    const by = Object.fromEntries(res.commits.map((c) => [c.sha, c]));
    // Default branch owns its first-parent chain (m3 → m2 → m1)...
    expect(by.m3.primaryBranch).toBe('main');
    expect(by.m2.primaryBranch).toBe('main');
    expect(by.m1.primaryBranch).toBe('main');
    // ...feature claims its own chain (f2 → f1), not swept up by main.
    expect(by.f2.primaryBranch).toBe('feature/x');
    expect(by.f1.primaryBranch).toBe('feature/x');

    // Merge node: parents >= 2 + message regex → PR #12.
    expect(by.m3.isMerge).toBe(true);
    expect(by.m3.prNumber).toBe(12);
    // Non-merge commits never carry a PR number.
    expect(by.f2.isMerge).toBe(false);
    expect(by.f2.prNumber).toBeNull();

    // Off-screen parent stays as a dangling SHA (client treats as edge stub).
    expect(by.m1.parents).toEqual(['m0-offscreen']);

    expect(res.branches).toEqual([
      { name: 'main', tipSha: 'm3', isDefault: true },
      { name: 'feature/x', tipSha: 'f2', isDefault: false },
    ]);
    expect(res.truncated).toBe(false);
  });

  // NOTE: this feeds associatedPrNumber directly into assembleGraph to exercise
  // the fallback branch. In production the bulk query no longer populates
  // associatedPrNumber (dropped in 06-05 to fix the 502); only the merge-message
  // regex path fires there. The flow logic itself is unchanged, so the fallback
  // still works for any caller that does supply a PR number.
  it('falls back to associatedPullRequests for squash/rebase merge messages', () => {
    const squash = rawCommit('s1', ['m3', 'f9'], '2026-06-04T02:00:00Z', {
      message: 'feat: squashed feature (#34)',
      associatedPrNumber: 34,
    });
    const res = assembleGraph([
      {
        name: 'main',
        tipSha: 's1',
        isDefault: true,
        commits: [squash, M3, M2, M1],
        truncated: false,
      },
    ]);
    const s = res.commits.find((c) => c.sha === 's1')!;
    expect(s.isMerge).toBe(true);
    expect(s.prNumber).toBe(34);
  });

  it('surfaces per-branch history truncation', () => {
    const res = assembleGraph([
      { ...BRANCHES[0], truncated: true },
      BRANCHES[1],
    ]);
    expect(res.truncated).toBe(true);
  });
});

// ---- Handler ------------------------------------------------------------------

describe('getCommitGraph handler', () => {
  it('rejects unauthenticated calls', async () => {
    await expect(
      handler({ auth: null, data: { repoId: REPO } }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects a missing repoId', async () => {
    await expect(
      handler({ auth: { uid: 'u1' }, data: {} }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a half-open range', async () => {
    await expect(
      handler({
        auth: { uid: 'u1' },
        data: { repoId: REPO, startDate: '2026-06-01' },
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a malformed date', async () => {
    await expect(
      handler({
        auth: { uid: 'u1' },
        data: { repoId: REPO, startDate: '06/01', endDate: '2026-06-04' },
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('404s on an unknown repo', async () => {
    await expect(
      handler({ auth: { uid: 'u1' }, data: { repoId: 'nope_repo' } }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('requires a stored GitHub token', async () => {
    store.delete('apps/gitsync/users/u1');
    await expect(
      handler({ auth: { uid: 'u1' }, data: { repoId: REPO } }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('fetches, assembles and caches the graph (cached: false on first call)', async () => {
    mockFetchCommitGraph.mockResolvedValue({
      branches: BRANCHES,
      defaultBranch: 'main',
      branchesTruncated: false,
    });

    const res = await handler({
      auth: { uid: 'u1' },
      data: { repoId: REPO, startDate: '2026-06-01', endDate: '2026-06-04' },
    });

    expect(mockFetchCommitGraph).toHaveBeenCalledWith(
      'team17',
      'gitsync',
      'tok',
      expect.objectContaining({ since: expect.any(String), until: expect.any(String) }),
    );
    expect(res.cached).toBe(false);
    expect((res.commits as unknown[]).length).toBe(5);
    expect(setSpy).toHaveBeenCalledWith(
      `apps/gitsync/repos/${REPO}/graphCache/2026-06-01_2026-06-04`,
      expect.objectContaining({ generatedAtMs: expect.any(Number) }),
    );
  });

  it('serves a fresh cache hit without refetching', async () => {
    store.set(`apps/gitsync/repos/${REPO}/graphCache/recent`, {
      payload: { commits: [], branches: [], truncated: false },
      generatedAtMs: Date.now(),
    });

    const res = await handler({ auth: { uid: 'u1' }, data: { repoId: REPO } });

    expect(res.cached).toBe(true);
    expect(mockFetchCommitGraph).not.toHaveBeenCalled();
  });

  it('force bypasses a fresh cache and refetches', async () => {
    store.set(`apps/gitsync/repos/${REPO}/graphCache/recent`, {
      payload: { commits: [], branches: [], truncated: false },
      generatedAtMs: Date.now(),
    });
    mockFetchCommitGraph.mockResolvedValue({
      branches: BRANCHES,
      defaultBranch: 'main',
      branchesTruncated: false,
    });

    const res = await handler({
      auth: { uid: 'u1' },
      data: { repoId: REPO, force: true },
    });

    expect(mockFetchCommitGraph).toHaveBeenCalled();
    expect(res.cached).toBe(false);
  });

  it('maps a GitHub API failure to unavailable', async () => {
    mockFetchCommitGraph.mockRejectedValue(new Error('rate limited'));
    await expect(
      handler({ auth: { uid: 'u1' }, data: { repoId: REPO } }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  // ---- 06-05 D7: best-effort commit-doc sync on a non-cached fetch ----------

  it('syncs fetched commits into Firestore docs with the webhook shape', async () => {
    mockFetchCommitGraph.mockResolvedValue({
      branches: BRANCHES,
      defaultBranch: 'main',
      branchesTruncated: false,
    });
    // f1 already ingested + enriched on its feature branch — must NOT be clobbered.
    const f1Path = `apps/gitsync/repos/${REPO}/commits/f1`;
    store.set(f1Path, { branch: 'feature/x', aiSummary: 'enriched' });

    await handler({ auth: { uid: 'u1' }, data: { repoId: REPO } });

    // A create was attempted for every fetched commit (5 in the fixture).
    const attemptedShas = createSpy.mock.calls.map((c) =>
      (c[0] as string).split('/').pop(),
    );
    expect(new Set(attemptedShas)).toEqual(new Set(['m3', 'f2', 'f1', 'm2', 'm1']));

    // f2 was newly created with the webhook shape (branch + Timestamp committedAt).
    const f2 = store.get(`apps/gitsync/repos/${REPO}/commits/f2`)!;
    expect(f2).toMatchObject({
      repoId: REPO,
      sha: 'f2',
      message: 'commit f2',
      author: { login: 'alice-dev', name: 'Alice', email: '' },
      url: `https://github.com/team17/gitsync/commit/f2`,
      filesChanged: [],
      added: [],
      removed: [],
      modified: [],
      branch: 'feature/x',
    });
    // committedAt is a real Timestamp parsed from the ISO string, not the string.
    expect((f2.committedAt as { __ms__: number }).__ms__).toBe(
      Date.parse('2026-06-03T01:00:00Z'),
    );

    // First-seen wins: the pre-existing enriched f1 doc is untouched.
    expect(store.get(f1Path)).toEqual({ branch: 'feature/x', aiSummary: 'enriched' });
  });

  it('a create failure (non-ALREADY_EXISTS) does not fail the graph call', async () => {
    mockFetchCommitGraph.mockResolvedValue({
      branches: BRANCHES,
      defaultBranch: 'main',
      branchesTruncated: false,
    });
    createFailPaths.add(`apps/gitsync/repos/${REPO}/commits/m1`);

    const res = await handler({ auth: { uid: 'u1' }, data: { repoId: REPO } });

    expect(res.cached).toBe(false);
    expect((res.commits as unknown[]).length).toBe(5);
  });

  it('does not sync commit docs on a cache hit', async () => {
    store.set(`apps/gitsync/repos/${REPO}/graphCache/recent`, {
      payload: { commits: [], branches: [], truncated: false },
      generatedAtMs: Date.now(),
    });

    await handler({ auth: { uid: 'u1' }, data: { repoId: REPO } });

    expect(createSpy).not.toHaveBeenCalled();
  });
});
