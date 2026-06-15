// Unit tests for importCollaborators (add GitHub collaborators who already have
// a GitSync account as repo members). Boundary mocks: onCall returns the raw
// handler, fake Firestore (equality 'where' honored), mocked githubClient.

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
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__ts__',
    arrayUnion: (...v: unknown[]) => ({ __arrayUnion: v }),
  },
}));

const store = new Map<string, Record<string, unknown>>();
const committed: Array<{ op: string; path: string; data?: unknown }> = [];

function childDocsOf(colPath: string): Array<[string, Record<string, unknown>]> {
  return [...store.entries()].filter(
    ([p]) =>
      p.startsWith(`${colPath}/`) &&
      p.slice(colPath.length + 1).indexOf('/') === -1,
  );
}

function makeQuery(
  colPath: string,
  clauses: Array<{ field: string; op: string; value: unknown }>,
) {
  const matches = () =>
    childDocsOf(colPath).filter(([, d]) =>
      clauses.every((c) => (c.op === '==' ? d[c.field] === c.value : true)),
    );
  const q = {
    where: (field: string, op: string, value: unknown) =>
      makeQuery(colPath, [...clauses, { field, op, value }]),
    limit: () => q,
    async get() {
      const docs = matches().map(([p, d]) => ({
        id: p.split('/').pop() as string,
        data: () => d,
      }));
      return { empty: docs.length === 0, docs };
    },
  };
  return q;
}

const fakeDb = {
  doc: (path: string) => ({
    path,
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
  }),
  collection: (path: string) => makeQuery(path, []),
  batch: () => ({
    set: (ref: { path: string }, data: unknown) =>
      committed.push({ op: 'set', path: ref.path, data }),
    update: (ref: { path: string }, data: unknown) =>
      committed.push({ op: 'update', path: ref.path, data }),
    async commit() {
      /* writes already recorded */
    },
  }),
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

const mockListCollaborators = jest.fn();
jest.mock('../services/githubClient', () => ({
  listCollaborators: (...a: unknown[]) => mockListCollaborators(...a),
}));

import { importCollaborators } from '../handlers/importCollaborators';

const REPO = 'octocat_hello';
const handler = importCollaborators as unknown as (req: unknown) => Promise<{
  added: number;
  alreadyMembers: number;
  pending: string[];
}>;

beforeEach(() => {
  store.clear();
  committed.length = 0;
  mockListCollaborators.mockReset();
  store.set(`apps/gitsync/repos/${REPO}`, { name: 'octocat/hello' });
  store.set('apps/gitsync/users/caller', { githubAccessToken: 'ght' });
});

const req = (data: unknown, uid = 'caller') => ({ auth: { uid }, data });

describe('importCollaborators', () => {
  it('rejects unauthenticated callers', async () => {
    await expect(handler({ data: { repoId: REPO } })).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('requires repoId', async () => {
    await expect(handler(req({}))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('adds collaborators with an account, marks the rest pending', async () => {
    // alice has an account + isn't a member; bob has an account + already a member;
    // carol has no GitSync account → pending.
    store.set('apps/gitsync/users/u-alice', { githubLogin: 'alice' });
    store.set('apps/gitsync/users/u-bob', { githubLogin: 'bob' });
    store.set(`apps/gitsync/repos/${REPO}/members/u-bob`, { role: 'member' });
    mockListCollaborators.mockResolvedValue([
      { login: 'alice', avatarUrl: null },
      { login: 'bob', avatarUrl: null },
      { login: 'carol', avatarUrl: null },
    ]);

    const res = await handler(req({ repoId: REPO }));

    expect(res).toEqual({ added: 1, alreadyMembers: 1, pending: ['carol'] });
    // alice's member doc + the repo memberIds arrayUnion were written.
    expect(committed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'set',
          path: `apps/gitsync/repos/${REPO}/members/u-alice`,
        }),
        expect.objectContaining({
          op: 'update',
          path: `apps/gitsync/repos/${REPO}`,
        }),
      ]),
    );
  });

  it('throws failed-precondition when the caller has no GitHub token', async () => {
    store.set('apps/gitsync/users/caller', {}); // no token
    await expect(handler(req({ repoId: REPO }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(mockListCollaborators).not.toHaveBeenCalled();
  });
});
