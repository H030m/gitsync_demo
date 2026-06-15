// Unit tests for onCommitCompletesTask (AI-judged auto-complete on default-branch
// commits). Covers the 06-14 acceptance criteria.
//
// Boundary mocks:
//   - firebase-functions/v2/firestore → onDocumentWritten returns raw handler.
//   - firebase-functions/v2 → logger no-op.
//   - firebase-admin/firestore → FieldValue.serverTimestamp + increment.
//   - ../admin → fake Firestore (doc/get + collection/where/get + runTransaction).
//   - ../config → getOpenAI with mocked chat.completions.create; MODELS.
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

const mockChatCreate = jest.fn();
jest.mock('../config', () => ({
  getOpenAI: () => ({ chat: { completions: { create: mockChatCreate } } }),
  MODELS: { reasoning: 'gpt-4o', fast: 'gpt-4o-mini', embedding: 'text-embedding-3-small' },
  openaiKey: { value: () => 'k' },
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

import { onCommitCompletesTask } from '../triggers/onCommitCompletesTask';

const REPO_ID = 'octocat_hello';
const SHA = 'abc123';
const handler = onCommitCompletesTask as unknown as (event: unknown) => Promise<void>;

function judgeResponse(complete: boolean, confidence: number, reason = 'r') {
  return {
    choices: [
      { message: { content: JSON.stringify({ complete, confidence, reason }) } },
    ],
  };
}

function makeEvent(opts: {
  beforeOnDefault?: boolean;
  // 'absent' = the after doc has NO onDefaultBranch field (feature-branch create).
  afterOnDefault?: boolean | 'absent';
  message?: string;
  filesChanged?: string[];
  afterPresent?: boolean;
  id?: string;
}) {
  const {
    beforeOnDefault,
    afterOnDefault = true,
    message = 'implement login closes #3',
    filesChanged = ['lib/login.dart'],
    afterPresent = true,
    id = 'evt-1',
  } = opts;
  const afterData: Record<string, unknown> = { message, filesChanged };
  if (afterOnDefault !== 'absent') afterData.onDefaultBranch = afterOnDefault;
  return {
    id,
    params: { repoId: REPO_ID, sha: SHA },
    data: {
      before: {
        data: () =>
          beforeOnDefault === undefined ? undefined : { onDefaultBranch: beforeOnDefault },
      },
      after: {
        data: () => (afterPresent ? afterData : undefined),
      },
    },
  };
}

function seedTask(id: string, data: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${REPO_ID}/tasks/${id}`, data);
}
function seedMember(uid: string, data: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${REPO_ID}/members/${uid}`, data);
}

beforeEach(() => {
  store.clear();
  mockMarkIdempotent.mockReset().mockResolvedValue(true);
  mockChatCreate.mockReset().mockResolvedValue(judgeResponse(true, 0.95));
});

describe('onCommitCompletesTask', () => {
  it('default-branch + matching ref + agent complete(high conf) → markTaskDone', async () => {
    seedTask('t1', {
      status: 'todo',
      assigneeId: 'u1',
      githubIssueNumber: 3,
      title: 'Login',
    });
    seedMember('u1', { completedTaskCount: 0, activeIssueCount: 1 });

    await handler(makeEvent({ beforeOnDefault: undefined }));

    const task = store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`);
    expect(task?.status).toBe('done');
    const member = store.get(`apps/gitsync/repos/${REPO_ID}/members/u1`);
    expect(member?.completedTaskCount).toBe(1);
    expect(member?.activeIssueCount).toBe(0);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    // JSON mode is used.
    expect(mockChatCreate.mock.calls[0][0].response_format).toEqual({ type: 'json_object' });
    expect(mockChatCreate.mock.calls[0][0].model).toBe('gpt-4o-mini');
  });

  it('non-default branch (onDefaultBranch not set) → no-op', async () => {
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    // after has no onDefaultBranch flag (feature branch create).
    await handler(makeEvent({ beforeOnDefault: undefined, afterOnDefault: 'absent' }));
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('non-default-branch write does NOT consume the shared idempotency key', async () => {
    // The feature-branch `.create()` fires BOTH onCommitCreated and this trigger
    // with the SAME event.id. The transition guard MUST run before markIdempotent
    // so this trigger never starves onCommitCreated of its linking/embedding key.
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(makeEvent({ beforeOnDefault: undefined, afterOnDefault: 'absent' }));
    expect(mockMarkIdempotent).not.toHaveBeenCalled();
  });

  it('already-true (no transition) does NOT consume the idempotency key', async () => {
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(makeEvent({ beforeOnDefault: true, afterOnDefault: true }));
    expect(mockMarkIdempotent).not.toHaveBeenCalled();
  });

  it('already true before (no transition, e.g. re-fire) → no-op', async () => {
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(makeEvent({ beforeOnDefault: true, afterOnDefault: true }));
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('deletion (no after) → no-op', async () => {
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(makeEvent({ beforeOnDefault: true, afterPresent: false }));
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
  });

  it('agent says not complete → no markDone', async () => {
    mockChatCreate.mockResolvedValue(judgeResponse(false, 0.95));
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(makeEvent({ beforeOnDefault: undefined }));
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
  });

  it('agent complete but low confidence (< threshold) → no markDone', async () => {
    mockChatCreate.mockResolvedValue(judgeResponse(true, 0.5));
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(makeEvent({ beforeOnDefault: undefined }));
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
  });

  it('already-done task → judge not called, no double count', async () => {
    seedTask('t1', { status: 'done', assigneeId: 'u1', githubIssueNumber: 3 });
    seedMember('u1', { completedTaskCount: 1, activeIssueCount: 0 });
    await handler(makeEvent({ beforeOnDefault: undefined }));
    const member = store.get(`apps/gitsync/repos/${REPO_ID}/members/u1`);
    expect(member?.completedTaskCount).toBe(1);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('no issue ref in message → no judge, no markDone', async () => {
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(makeEvent({ beforeOnDefault: undefined, message: 'wip refactor' }));
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('OpenAI throws → judge degrades, trigger does not throw, no markDone', async () => {
    mockChatCreate.mockRejectedValue(new Error('openai down'));
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await expect(handler(makeEvent({ beforeOnDefault: undefined }))).resolves.toBeUndefined();
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
  });

  it('unparseable JSON → judge degrades, no markDone', async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: 'not json' } }] });
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await expect(handler(makeEvent({ beforeOnDefault: undefined }))).resolves.toBeUndefined();
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
  });

  it('duplicate delivery → no-op', async () => {
    mockMarkIdempotent.mockResolvedValue(false);
    seedTask('t1', { status: 'todo', githubIssueNumber: 3 });
    await handler(makeEvent({ beforeOnDefault: undefined }));
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/tasks/t1`)?.status).toBe('todo');
    expect(mockChatCreate).not.toHaveBeenCalled();
  });
});
