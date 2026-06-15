// Unit tests for the removeRepo callable.
//
// Same boundary-mocking pattern as addRepo.test.ts:
//   - firebase-functions/v2/https → onCall returns the raw async handler.
//   - firebase-functions/v2 → logger is a no-op.
//   - ../admin → db is a hand-rolled fake Firestore (doc/get/delete +
//     recursiveDelete spy).
//   - ../services/githubClient → deleteWebhook is a mock.

// ---- Mocks ----------------------------------------------------------------

class FakeHttpsError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'HttpsError';
  }
}

jest.mock('firebase-functions/v2/https', () => ({
  HttpsError: FakeHttpsError,
  onCall: (_opts: unknown, handler: unknown) => handler,
}));

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockDeleteWebhook = jest.fn();
jest.mock('../services/githubClient', () => ({
  deleteWebhook: (...args: unknown[]) => mockDeleteWebhook(...args),
}));

// ---- Fake Firestore -------------------------------------------------------
//
// Documents are keyed by path. `get()` reflects the in-memory store; `delete()`
// removes a doc and records the path; `recursiveDelete(ref)` is a spy that also
// drops the doc from the store.

interface FakeDoc {
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
}

const store = new Map<string, Record<string, unknown>>();
const deletedPaths: string[] = [];
const mockRecursiveDelete = jest.fn(async (ref: { path: string }) => {
  store.delete(ref.path);
});

function makeDocRef(path: string) {
  return {
    path,
    async get(): Promise<FakeDoc> {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    async delete(): Promise<void> {
      deletedPaths.push(path);
      store.delete(path);
    },
  };
}

const fakeDb = {
  doc: (path: string) => makeDocRef(path),
  recursiveDelete: (ref: { path: string }) => mockRecursiveDelete(ref),
};

jest.mock('../admin', () => ({
  db: fakeDb,
  REGION: 'asia-east1',
}));

// Import after mocks are registered.
import { removeRepo } from '../handlers/removeRepo';

const handler = removeRepo as unknown as (req: {
  auth?: { uid: string };
  data: unknown;
}) => Promise<Record<string, unknown>>;

beforeEach(() => {
  store.clear();
  deletedPaths.length = 0;
  mockDeleteWebhook.mockReset();
  mockRecursiveDelete.mockClear();
});

function seedRepo(repoId: string, data: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${repoId}`, data);
}

describe('removeRepo', () => {
  it('rejects when not logged in → failed-precondition', async () => {
    await expect(
      handler({ data: { repoId: 'octocat_hello' } }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects missing/bad repoId → invalid-argument', async () => {
    await expect(
      handler({ auth: { uid: 'u1' }, data: {} }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });

    await expect(
      handler({ auth: { uid: 'u1' }, data: { repoId: 123 } }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects when repo does not exist → not-found', async () => {
    await expect(
      handler({ auth: { uid: 'u1' }, data: { repoId: 'octocat_hello' } }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects non-owner → permission-denied', async () => {
    seedRepo('octocat_hello', {
      name: 'octocat/hello',
      memberIds: ['owner1', 'u2'],
      createdBy: 'owner1',
    });
    // u2 is a member but not owner, and not createdBy.
    store.set('apps/gitsync/repos/octocat_hello/members/u2', { role: 'member' });
    await expect(
      handler({ auth: { uid: 'u2' }, data: { repoId: 'octocat_hello' } }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('succeeds: deletes webhook, member pointers, recursiveDelete, returns {}', async () => {
    seedRepo('octocat_hello', {
      name: 'octocat/hello',
      url: 'https://github.com/octocat/hello',
      webhookId: 999,
      memberIds: ['owner1', 'u2'],
      createdBy: 'owner1',
    });
    store.set('apps/gitsync/repos/octocat_hello/members/owner1', { role: 'owner' });
    store.set('apps/gitsync/users/owner1', { githubAccessToken: 'tok' });
    store.set('apps/gitsync/users/owner1/repos/octocat_hello', { role: 'owner' });
    store.set('apps/gitsync/users/u2/repos/octocat_hello', { role: 'member' });
    mockDeleteWebhook.mockResolvedValue(undefined);

    const res = await handler({
      auth: { uid: 'owner1' },
      data: { repoId: 'octocat_hello' },
    });
    expect(res).toEqual({});

    expect(mockDeleteWebhook).toHaveBeenCalledWith('octocat', 'hello', 'tok', 999);

    // Both member pointers deleted.
    expect(deletedPaths).toContain('apps/gitsync/users/owner1/repos/octocat_hello');
    expect(deletedPaths).toContain('apps/gitsync/users/u2/repos/octocat_hello');

    // Repo doc + subcollections removed via recursiveDelete on the repo ref.
    expect(mockRecursiveDelete).toHaveBeenCalledTimes(1);
    expect(mockRecursiveDelete.mock.calls[0][0]).toMatchObject({
      path: 'apps/gitsync/repos/octocat_hello',
    });
    expect(store.get('apps/gitsync/repos/octocat_hello')).toBeUndefined();
  });

  it('owner via createdBy (no members doc) still succeeds', async () => {
    seedRepo('octocat_hello', {
      name: 'octocat/hello',
      webhookId: 999,
      memberIds: ['owner1'],
      createdBy: 'owner1',
    });
    store.set('apps/gitsync/users/owner1', { githubAccessToken: 'tok' });
    mockDeleteWebhook.mockResolvedValue(undefined);

    const res = await handler({
      auth: { uid: 'owner1' },
      data: { repoId: 'octocat_hello' },
    });
    expect(res).toEqual({});
    expect(mockRecursiveDelete).toHaveBeenCalledTimes(1);
  });

  it('webhook delete failure still cleans up Firestore', async () => {
    seedRepo('octocat_hello', {
      name: 'octocat/hello',
      webhookId: 999,
      memberIds: ['owner1'],
      createdBy: 'owner1',
    });
    store.set('apps/gitsync/users/owner1', { githubAccessToken: 'tok' });
    store.set('apps/gitsync/users/owner1/repos/octocat_hello', { role: 'owner' });
    mockDeleteWebhook.mockRejectedValue({ status: 404 });

    const res = await handler({
      auth: { uid: 'owner1' },
      data: { repoId: 'octocat_hello' },
    });
    expect(res).toEqual({});
    expect(deletedPaths).toContain('apps/gitsync/users/owner1/repos/octocat_hello');
    expect(mockRecursiveDelete).toHaveBeenCalledTimes(1);
  });

  it('repo with no webhookId skips webhook delete', async () => {
    seedRepo('octocat_hello', {
      name: 'octocat/hello',
      webhookId: null,
      memberIds: ['owner1'],
      createdBy: 'owner1',
    });
    store.set('apps/gitsync/users/owner1/repos/octocat_hello', { role: 'owner' });

    const res = await handler({
      auth: { uid: 'owner1' },
      data: { repoId: 'octocat_hello' },
    });
    expect(res).toEqual({});
    expect(mockDeleteWebhook).not.toHaveBeenCalled();
    expect(mockRecursiveDelete).toHaveBeenCalledTimes(1);
  });
});
