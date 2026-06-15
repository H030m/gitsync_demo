// Unit tests for onPRMerged (mark linked tasks done + bump counters).
//
// Boundary mocks:
//   - firebase-functions/v2/firestore → onDocumentWritten returns raw handler.
//   - firebase-functions/v2 → logger no-op.
//   - firebase-admin/firestore → FieldValue.serverTimestamp + increment.
//   - ../admin → fake Firestore (doc/get/update + collection/where/get +
//     runTransaction).
//   - ../tools/idempotency → markIdempotent mocked.

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

// ---- Fake Firestore with transactions -------------------------------------

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

function makeDocRef(path: string) {
  return {
    path,
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
  };
}

const fakeDb = {
  doc: (path: string) => makeDocRef(path),
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

import { onPRMerged } from '../triggers/onPRMerged';

const REPO_ID = 'octocat_hello';
const handler = onPRMerged as unknown as (event: unknown) => Promise<void>;

function makeEvent(
  beforeState: string | undefined,
  after: Record<string, unknown> | undefined,
  id = 'evt-1',
) {
  return {
    id,
    params: { repoId: REPO_ID, prNumber: '7' },
    data: {
      before: { data: () => (beforeState === undefined ? undefined : { state: beforeState }) },
      after: { data: () => after },
    },
  };
}

beforeEach(() => {
  store.clear();
  mockMarkIdempotent.mockReset().mockResolvedValue(true);
});

function seedTask(id: string, data: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${REPO_ID}/tasks/${id}`, data);
}
function seedMember(uid: string, data: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${REPO_ID}/members/${uid}`, data);
}

describe('onPRMerged', () => {
  it('marks linked task done once + bumps assignee counters', async () => {
    seedTask('t1', { status: 'todo', assigneeId: 'u1', githubIssueNumber: 3 });
    seedMember('u1', { completedTaskCount: 0, activeIssueCount: 1 });

    await handler(
      makeEvent('open', { state: 'merged', title: 'X', body: 'closes #3' }),
    );

    const task = store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`);
    expect(task?.status).toBe('done');
    const member = store.get(`apps/gitsync/repos/${REPO_ID}/members/u1`);
    expect(member?.completedTaskCount).toBe(1);
    expect(member?.activeIssueCount).toBe(0);
  });

  it('create-as-merged (no before) → marks task done', async () => {
    // Real-world path: handlePR writes the pullRequests doc already in state
    // `merged`, so the trigger sees a CREATE (no before) — must still fire.
    seedTask('t1', { status: 'todo', assigneeId: 'u1', githubIssueNumber: 3 });
    seedMember('u1', { completedTaskCount: 0, activeIssueCount: 1 });

    await handler(
      makeEvent(undefined, { state: 'merged', title: 'X', body: 'closes #3' }),
    );

    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('done');
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/members/u1`)?.completedTaskCount).toBe(1);
  });

  it('deletion (no after) → no-op', async () => {
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(makeEvent('merged', undefined));
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
  });

  it('no double-count when task is already done (re-fire)', async () => {
    seedTask('t1', { status: 'done', assigneeId: 'u1', githubIssueNumber: 3 });
    seedMember('u1', { completedTaskCount: 1, activeIssueCount: 0 });

    await handler(
      makeEvent('open', { state: 'merged', title: 'X', body: 'fixes #3' }),
    );

    const member = store.get(`apps/gitsync/repos/${REPO_ID}/members/u1`);
    expect(member?.completedTaskCount).toBe(1);
  });

  it('guard: ignores when not a fresh transition to merged', async () => {
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(
      makeEvent('merged', { state: 'merged', title: 'X', body: 'closes #3' }),
    );
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
  });

  it('falls back to plain #N in body when no closing keyword', async () => {
    seedTask('t1', { status: 'todo', githubIssueNumber: 5, assigneeId: 'u1' });
    seedMember('u1', { completedTaskCount: 0, activeIssueCount: 1 });
    await handler(
      makeEvent('open', { state: 'merged', title: 'X', body: 'see #5' }),
    );
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('done');
  });

  it('duplicate delivery → no-op', async () => {
    mockMarkIdempotent.mockResolvedValue(false);
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(
      makeEvent('open', { state: 'merged', title: 'X', body: 'closes #3' }),
    );
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
  });
});
