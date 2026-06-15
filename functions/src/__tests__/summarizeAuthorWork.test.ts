// Unit tests for summarizeAuthorWorkFlow (進度表 per-author AI work summary).
//
// Same boundary-mock style as explainCommit.test.ts: fake Firestore (full
// collection .get() + doc set/get), scripted OpenAI, no-op logger.

class FakeHttpsError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'HttpsError';
  }
}

jest.mock('firebase-functions/v2/https', () => ({ HttpsError: FakeHttpsError }));
jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
}));

const store = new Map<string, Record<string, unknown>>();
const setSpy = jest.fn();

function childDocsOf(colPath: string): Array<[string, Record<string, unknown>]> {
  return [...store.entries()].filter(
    ([p]) =>
      p.startsWith(`${colPath}/`) &&
      p.slice(colPath.length + 1).indexOf('/') === -1,
  );
}

const fakeDb = {
  doc: (path: string) => ({
    path,
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    async set(patch: Record<string, unknown>) {
      store.set(path, patch);
      setSpy(path, patch);
    },
  }),
  // The flow reads the whole commits collection (no query clauses).
  collection: (path: string) => ({
    async get() {
      return {
        docs: childDocsOf(path).map(([p, d]) => ({
          id: p.split('/').pop() as string,
          data: () => d,
        })),
      };
    },
  }),
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

let nextContent: string | null = '- 做了 OAuth 登入功能';
const mockCreate = jest.fn(async () => ({
  choices: [{ message: { role: 'assistant', content: nextContent } }],
}));

jest.mock('../config', () => ({
  getOpenAI: () => ({ chat: { completions: { create: mockCreate } } }),
  MODELS: { reasoning: 'gpt-4o', fast: 'gpt-4o-mini', embedding: 'text-embedding-3-small' },
}));

import { summarizeAuthorWorkFlow } from '../flows/summarizeAuthorWork';

const REPO = 'team17_gitsync';

function seedCommit(sha: string, data: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${REPO}/commits/${sha}`, {
    message: 'work',
    additions: 1,
    deletions: 0,
    committedAt: '2026-06-01T00:00:00Z',
    ...data,
  });
}

beforeEach(() => {
  store.clear();
  setSpy.mockClear();
  mockCreate.mockClear();
  nextContent = '- 做了 OAuth 登入功能';
});

describe('summarizeAuthorWorkFlow', () => {
  it('throws not-found when no commits match the author', async () => {
    seedCommit('c1', { author: { login: 'someone-else', name: 'Other' } });

    await expect(
      summarizeAuthorWorkFlow({ repoId: REPO, login: 'alice-dev', names: [] }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('filters by login case-insensitively AND merges name-only docs via names[]', async () => {
    // login-keyed commit (canonical), different casing in the doc.
    seedCommit('c1', {
      message: 'feat: tree map',
      author: { login: 'H030m', name: '倪嘉駿' },
      committedAt: '2026-06-03T00:00:00Z',
    });
    // login-less doc (GraphQL backfill) that should merge via the name.
    seedCommit('c2', {
      message: 'fix: pie legend',
      author: { login: '', name: '倪嘉駿' },
      committedAt: '2026-06-02T00:00:00Z',
    });
    // an unrelated author — must NOT be included.
    seedCommit('c3', { author: { login: 'temmie', name: 'Temmie' } });

    const res = await summarizeAuthorWorkFlow({
      repoId: REPO,
      login: 'h030m', // lower-case caller login
      names: ['倪嘉駿'],
    });

    expect(res.cached).toBe(false);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const userMsg = (mockCreate.mock.calls[0] as unknown as [
      { messages: Array<{ role: string; content: string }> },
    ])[0].messages.find((m) => m.role === 'user');
    // Both the login doc and the name-only doc are in the prompt (count = 2).
    expect(userMsg?.content).toContain('feat: tree map');
    expect(userMsg?.content).toContain('fix: pie legend');
    expect(userMsg?.content).toContain('commit 總數：2');
    // The unrelated author's commit is absent.
    expect(userMsg?.content).not.toContain('temmie');
    // Cache written with the matched count.
    expect(setSpy).toHaveBeenCalledTimes(1);
    const [, patch] = setSpy.mock.calls[0];
    expect(patch).toMatchObject({ commitCount: 2, markdown: res.markdown });
  });

  it('returns the cache without calling OpenAI when count matches and not forced', async () => {
    seedCommit('c1', { author: { login: 'alice-dev', name: 'Alice' } });
    store.set(
      `apps/gitsync/repos/${REPO}/authorSummaries/login-alice-dev`,
      { markdown: 'cached summary', commitCount: 1 },
    );

    const res = await summarizeAuthorWorkFlow({
      repoId: REPO,
      login: 'alice-dev',
      names: [],
    });

    expect(res).toEqual({ markdown: 'cached summary', cached: true });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('busts the cache when the commit count drifts', async () => {
    seedCommit('c1', { author: { login: 'alice-dev', name: 'Alice' } });
    seedCommit('c2', { author: { login: 'alice-dev', name: 'Alice' } });
    // Stale cache recorded only 1 commit.
    store.set(
      `apps/gitsync/repos/${REPO}/authorSummaries/login-alice-dev`,
      { markdown: 'stale', commitCount: 1 },
    );
    nextContent = '- fresh summary';

    const res = await summarizeAuthorWorkFlow({
      repoId: REPO,
      login: 'alice-dev',
      names: [],
    });

    expect(res).toEqual({ markdown: '- fresh summary', cached: false });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(
      `apps/gitsync/repos/${REPO}/authorSummaries/login-alice-dev`,
      expect.objectContaining({ commitCount: 2 }),
    );
  });

  it('force=true regenerates even when a fresh cache exists', async () => {
    seedCommit('c1', { author: { login: 'alice-dev', name: 'Alice' } });
    store.set(
      `apps/gitsync/repos/${REPO}/authorSummaries/login-alice-dev`,
      { markdown: 'cached summary', commitCount: 1 },
    );
    nextContent = '- regenerated';

    const res = await summarizeAuthorWorkFlow({
      repoId: REPO,
      login: 'alice-dev',
      names: [],
      force: true,
    });

    expect(res).toEqual({ markdown: '- regenerated', cached: false });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('throws internal when OpenAI returns nothing', async () => {
    seedCommit('c1', { author: { login: 'alice-dev', name: 'Alice' } });
    nextContent = null;

    await expect(
      summarizeAuthorWorkFlow({ repoId: REPO, login: 'alice-dev', names: [] }),
    ).rejects.toMatchObject({ code: 'internal' });
    expect(setSpy).not.toHaveBeenCalled();
  });
});
