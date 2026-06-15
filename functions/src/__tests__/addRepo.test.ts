// Unit tests for the addRepo callable.
//
// We mock the boundaries so the handler logic runs in isolation:
//   - firebase-functions/v2/https → onCall returns the raw async handler so we
//     can invoke it directly; HttpsError is a real class that captures `code`.
//   - firebase-functions/v2 → logger is a no-op.
//   - ../admin → db is a hand-rolled fake Firestore (doc/get/batch).
//   - ../services/githubClient → verifyRepoAccess / registerWebhook are mocks.

// ---- Mocks ----------------------------------------------------------------

class FakeHttpsError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'HttpsError';
  }
}

jest.mock('firebase-functions/v2/https', () => ({
  HttpsError: FakeHttpsError,
  // onCall just hands back the inner handler for direct invocation.
  onCall: (_opts: unknown, handler: unknown) => handler,
}));

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockVerifyRepoAccess = jest.fn();
const mockRegisterWebhook = jest.fn();
jest.mock('../services/githubClient', () => ({
  verifyRepoAccess: (...args: unknown[]) => mockVerifyRepoAccess(...args),
  registerWebhook: (...args: unknown[]) => mockRegisterWebhook(...args),
}));

// ---- Fake Firestore -------------------------------------------------------
//
// Documents are keyed by path. `get()` reflects the in-memory store; `batch`
// records set() calls and applies them on commit() so tests can assert what
// was written.

interface FakeDoc {
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
}

const store = new Map<string, Record<string, unknown>>();
const batchWrites: Array<{
  path: string;
  data: Record<string, unknown>;
  isUpdate?: boolean;
}> = [];

function makeDocRef(path: string) {
  return {
    path,
    async get(): Promise<FakeDoc> {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
  };
}

const fakeDb = {
  doc: (path: string) => makeDocRef(path),
  batch: () => ({
    set(ref: { path: string }, data: Record<string, unknown>) {
      batchWrites.push({ path: ref.path, data });
    },
    update(ref: { path: string }, data: Record<string, unknown>) {
      batchWrites.push({ path: ref.path, data, isUpdate: true });
    },
    async commit() {
      for (const w of batchWrites) {
        if (w.isUpdate) {
          store.set(w.path, { ...(store.get(w.path) ?? {}), ...w.data });
        } else {
          store.set(w.path, w.data);
        }
      }
    },
  }),
};

jest.mock('../admin', () => ({
  db: fakeDb,
  REGION: 'asia-east1',
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__serverTimestamp__',
    arrayUnion: (...vals: unknown[]) => ({ __arrayUnion__: vals }),
  },
}));

// Import after mocks are registered.
import { addRepo, parseGithubUrl } from '../handlers/addRepo';

// onCall mock returns the handler directly; the cast lets us invoke it.
const handler = addRepo as unknown as (req: {
  auth?: { uid: string };
  data: unknown;
}) => Promise<{ repoId: string; alreadyMember?: boolean }>;

function seedUser(uid: string, data: Record<string, unknown>) {
  store.set(`apps/gitsync/users/${uid}`, data);
}

beforeEach(() => {
  store.clear();
  batchWrites.length = 0;
  mockVerifyRepoAccess.mockReset();
  mockRegisterWebhook.mockReset();
  process.env.GCLOUD_PROJECT = 'gitsync-test';
});

// ---- parseGithubUrl -------------------------------------------------------

describe('parseGithubUrl', () => {
  it('parses https URLs', () => {
    expect(parseGithubUrl('https://github.com/octocat/hello')).toEqual({
      owner: 'octocat',
      repo: 'hello',
    });
  });
  it('parses owner/repo slug', () => {
    expect(parseGithubUrl('octocat/hello')).toEqual({
      owner: 'octocat',
      repo: 'hello',
    });
  });
  it('strips trailing .git and slash', () => {
    expect(parseGithubUrl('https://github.com/octocat/hello.git/')).toEqual({
      owner: 'octocat',
      repo: 'hello',
    });
  });
  it('parses ssh form', () => {
    expect(parseGithubUrl('git@github.com:octocat/hello.git')).toEqual({
      owner: 'octocat',
      repo: 'hello',
    });
  });
  it('returns null for garbage', () => {
    expect(parseGithubUrl('not a url')).toBeNull();
    expect(parseGithubUrl('')).toBeNull();
    expect(parseGithubUrl('https://github.com/onlyowner')).toBeNull();
  });
});

// ---- addRepo handler ------------------------------------------------------

describe('addRepo', () => {
  it('rejects when not logged in → failed-precondition', async () => {
    await expect(
      handler({ data: { githubUrl: 'octocat/hello' } }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects missing/bad githubUrl → invalid-argument', async () => {
    await expect(
      handler({ auth: { uid: 'u1' }, data: {} }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });

    await expect(
      handler({ auth: { uid: 'u1' }, data: { githubUrl: 'not a url' } }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects missing token → failed-precondition', async () => {
    // No user doc / no token.
    await expect(
      handler({ auth: { uid: 'u1' }, data: { githubUrl: 'octocat/hello' } }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('maps GitHub 404 → not-found', async () => {
    seedUser('u1', { githubAccessToken: 'tok' });
    mockVerifyRepoAccess.mockRejectedValue({ status: 404 });
    await expect(
      handler({ auth: { uid: 'u1' }, data: { githubUrl: 'octocat/hello' } }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects insufficient permission → failed-precondition', async () => {
    seedUser('u1', { githubAccessToken: 'tok' });
    mockVerifyRepoAccess.mockResolvedValue({
      githubRepoId: 123,
      defaultBranch: 'main',
      permissions: { admin: false, push: false, pull: true },
    });
    await expect(
      handler({ auth: { uid: 'u1' }, data: { githubUrl: 'octocat/hello' } }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('existing repo + verified non-member → joins as member, skips webhook', async () => {
    seedUser('u2', { githubAccessToken: 'tok2' });
    mockVerifyRepoAccess.mockResolvedValue({
      githubRepoId: 123,
      defaultBranch: 'main',
      permissions: { admin: false, push: true, pull: true },
    });
    // Repo already created by someone else (u1 is the owner).
    store.set('apps/gitsync/repos/octocat_hello', {
      name: 'octocat/hello',
      webhookId: 999,
      webhookSecret: 'orig-secret',
      memberIds: ['u1'],
      createdBy: 'u1',
    });

    const res = await handler({
      auth: { uid: 'u2' },
      data: { githubUrl: 'octocat/hello' },
    });
    expect(res).toEqual({ repoId: 'octocat_hello' });

    // Joiner gets a member doc + user pointer, both role 'member'.
    expect(
      store.get('apps/gitsync/repos/octocat_hello/members/u2'),
    ).toMatchObject({
      role: 'member',
      activeIssueCount: 0,
      completedTaskCount: 0,
    });
    expect(store.get('apps/gitsync/users/u2/repos/octocat_hello')).toEqual({
      role: 'member',
    });

    // memberIds extended via arrayUnion; existing repo fields untouched.
    const repoDoc = store.get('apps/gitsync/repos/octocat_hello');
    expect(repoDoc?.memberIds).toEqual({ __arrayUnion__: ['u2'] });
    expect(repoDoc?.webhookSecret).toBe('orig-secret');
    expect(repoDoc?.createdBy).toBe('u1');

    // Webhook is NOT re-registered on the join path.
    expect(mockRegisterWebhook).not.toHaveBeenCalled();
  });

  it('existing repo + caller already a member → idempotent, no writes', async () => {
    seedUser('u1', { githubAccessToken: 'tok' });
    mockVerifyRepoAccess.mockResolvedValue({
      githubRepoId: 123,
      defaultBranch: 'main',
      permissions: { admin: true, push: true, pull: true },
    });
    store.set('apps/gitsync/repos/octocat_hello', {
      name: 'octocat/hello',
      memberIds: ['u1'],
      createdBy: 'u1',
    });
    store.set('apps/gitsync/repos/octocat_hello/members/u1', {
      role: 'owner',
      activeIssueCount: 5,
    });

    const res = await handler({
      auth: { uid: 'u1' },
      data: { githubUrl: 'octocat/hello' },
    });
    expect(res).toEqual({ repoId: 'octocat_hello', alreadyMember: true });

    // Existing member doc left untouched; nothing batched.
    expect(
      store.get('apps/gitsync/repos/octocat_hello/members/u1'),
    ).toEqual({ role: 'owner', activeIssueCount: 5 });
    expect(batchWrites.length).toBe(0);
    expect(mockRegisterWebhook).not.toHaveBeenCalled();
  });

  it('existing repo + caller lacks push/admin → still rejected', async () => {
    seedUser('u3', { githubAccessToken: 'tok3' });
    mockVerifyRepoAccess.mockResolvedValue({
      githubRepoId: 123,
      defaultBranch: 'main',
      permissions: { admin: false, push: false, pull: true },
    });
    store.set('apps/gitsync/repos/octocat_hello', {
      name: 'octocat/hello',
      memberIds: ['u1'],
    });
    await expect(
      handler({ auth: { uid: 'u3' }, data: { githubUrl: 'octocat/hello' } }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    // Permission check runs before the create/join split → no member doc.
    expect(
      store.get('apps/gitsync/repos/octocat_hello/members/u3'),
    ).toBeUndefined();
  });

  it('succeeds: writes all three docs and returns repoId', async () => {
    seedUser('u1', { githubAccessToken: 'tok' });
    mockVerifyRepoAccess.mockResolvedValue({
      githubRepoId: 123,
      defaultBranch: 'main',
      permissions: { admin: true, push: true, pull: true },
    });
    mockRegisterWebhook.mockResolvedValue(999);

    const res = await handler({
      auth: { uid: 'u1' },
      data: { githubUrl: 'octocat/hello' },
    });
    expect(res).toEqual({ repoId: 'octocat_hello' });

    const repoDoc = store.get('apps/gitsync/repos/octocat_hello');
    expect(repoDoc).toMatchObject({
      name: 'octocat/hello',
      githubRepoId: 123,
      defaultBranch: 'main',
      webhookId: 999,
      memberIds: ['u1'],
      isBreakingDown: false,
      createdBy: 'u1',
    });
    expect(typeof repoDoc?.webhookSecret).toBe('string');

    expect(store.get('apps/gitsync/users/u1/repos/octocat_hello')).toEqual({
      role: 'owner',
    });
    expect(store.get('apps/gitsync/repos/octocat_hello/members/u1')).toMatchObject({
      role: 'owner',
      activeIssueCount: 0,
      completedTaskCount: 0,
    });

    // Webhook url derived from REGION + project.
    expect(mockRegisterWebhook).toHaveBeenCalledWith(
      'octocat',
      'hello',
      'tok',
      expect.objectContaining({
        url: 'https://asia-east1-gitsync-test.cloudfunctions.net/githubWebhook',
        events: ['push', 'pull_request', 'issues', 'issue_comment'],
      }),
    );
  });

  it('best-effort: webhook failure still creates repo with webhookId null', async () => {
    seedUser('u1', { githubAccessToken: 'tok' });
    mockVerifyRepoAccess.mockResolvedValue({
      githubRepoId: 123,
      defaultBranch: 'main',
      permissions: { admin: true, push: true, pull: true },
    });
    mockRegisterWebhook.mockRejectedValue({ status: 403 });

    const res = await handler({
      auth: { uid: 'u1' },
      data: { githubUrl: 'octocat/hello' },
    });
    expect(res).toEqual({ repoId: 'octocat_hello' });

    const repoDoc = store.get('apps/gitsync/repos/octocat_hello');
    expect(repoDoc?.webhookId).toBeNull();
    // Secret is still generated and stored for later backfill.
    expect(typeof repoDoc?.webhookSecret).toBe('string');
  });
});
