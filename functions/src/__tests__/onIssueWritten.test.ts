// Unit tests for onIssueWritten (reverse-sync issue state → task status).
//
// Same fake-Firestore-with-transactions style as onPRMerged.test.ts.

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (_opts: unknown, handler: unknown) => handler,
}));

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__ts__',
    increment: (n: number) => ({ __inc__: n }),
  },
}));

const mockMarkIdempotent = jest.fn();
jest.mock('../tools/idempotency', () => ({
  markIdempotent: (...args: unknown[]) => mockMarkIdempotent(...args),
}));

const store = new Map<string, Record<string, unknown>>();

function applyPatch(path: string, patch: Record<string, unknown>) {
  const cur = { ...(store.get(path) ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && '__inc__' in (v as object)) {
      cur[k] = ((cur[k] as number) ?? 0) + (v as { __inc__: number }).__inc__;
    } else {
      cur[k] = v;
    }
  }
  store.set(path, cur);
}

const fakeDb = {
  doc: (path: string) => ({
    path,
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
  }),
  collection: (path: string) => ({
    where: (field: string, _op: string, value: unknown) => ({
      async get() {
        const docs = [...store.entries()]
          .filter(([p]) => p.startsWith(`${path}/`) && p.slice(path.length + 1).indexOf('/') === -1)
          .filter(([, d]) => d[field] === value)
          .map(([p]) => ({ id: p.split('/').pop() as string }));
        return { docs };
      },
    }),
  }),
  async runTransaction(fn: (tx: unknown) => Promise<unknown>) {
    const tx = {
      async get(ref: { path: string }) {
        const data = store.get(ref.path);
        return { exists: data !== undefined, data: () => data };
      },
      update(ref: { path: string }, patch: Record<string, unknown>) {
        applyPatch(ref.path, patch);
      },
    };
    return fn(tx);
  },
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

import { onIssueWritten } from '../triggers/onIssueWritten';

const REPO_ID = 'octocat_hello';
const handler = onIssueWritten as unknown as (event: unknown) => Promise<void>;

function makeEvent(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  issueNumber = '3',
  id = 'evt-1',
) {
  return {
    id,
    params: { repoId: REPO_ID, issueNumber },
    data: {
      before: { data: () => before },
      after: { data: () => after },
    },
  };
}

function seedTask(id: string, data: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${REPO_ID}/tasks/${id}`, data);
}

beforeEach(() => {
  store.clear();
  mockMarkIdempotent.mockReset().mockResolvedValue(true);
});

describe('onIssueWritten', () => {
  it('issue closed → linked task marked done', async () => {
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(makeEvent({ state: 'open' }, { state: 'closed' }));
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('done');
  });

  it('issue reopened → task reverted to todo', async () => {
    seedTask('t1', { status: 'done', githubIssueNumber: 3 });
    await handler(makeEvent({ state: 'closed' }, { state: 'open' }));
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
  });

  it('no state transition (edit while open) → no-op', async () => {
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(makeEvent({ state: 'open' }, { state: 'open' }));
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
  });

  it('first write (no before) closed → marks done', async () => {
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(makeEvent(undefined, { state: 'closed' }));
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('done');
  });

  it('deletion (no after) → no-op', async () => {
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(makeEvent({ state: 'closed' }, undefined));
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
  });

  it('duplicate delivery → no-op', async () => {
    mockMarkIdempotent.mockResolvedValue(false);
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(makeEvent({ state: 'open' }, { state: 'closed' }));
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
  });
});
