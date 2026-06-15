// Unit tests for assignTaskFlow.
//
// Boundary mocks (same style as breakdownTask.test.ts / onIssueWritten.test.ts):
//   - firebase-functions/v2/https → HttpsError captures `code`.
//   - firebase-functions/v2 → logger no-op.
//   - firebase-admin/firestore → FieldValue.serverTimestamp + increment sentinels.
//   - ../admin → hand-rolled fake Firestore (doc/collection/where/findNearest/runTransaction).
//   - ../config → getOpenAI returns a mock whose chat.completions.create() is scripted per-test.
//   - ../tools/embedding → embed() stubbed (no real OpenAI embedding call).

class FakeHttpsError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'HttpsError';
  }
}

jest.mock('firebase-functions/v2/https', () => ({
  HttpsError: FakeHttpsError,
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

// ---- Fake Firestore -------------------------------------------------------

const store = new Map<string, Record<string, unknown>>();

// When set, the fake findNearest().get() throws this (simulates a missing
// vector index `9 FAILED_PRECONDITION` or any query failure).
let findNearestError: Error | null = null;

function childDocsOf(colPath: string): Array<[string, Record<string, unknown>]> {
  return [...store.entries()].filter(
    ([p]) =>
      p.startsWith(`${colPath}/`) &&
      p.slice(colPath.length + 1).indexOf('/') === -1,
  );
}

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

// Resolve a possibly-nested field path ("author.login") on a doc.
function getField(data: Record<string, unknown>, field: string): unknown {
  return field.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[k];
    return undefined;
  }, data);
}

interface WhereClause {
  field: string;
  op: string;
  value: unknown;
}

function makeQuery(colPath: string, clauses: WhereClause[]) {
  const matches = () =>
    childDocsOf(colPath).filter(([, d]) =>
      clauses.every((c) => {
        const fv = getField(d, c.field);
        if (c.op === 'array-contains') {
          return Array.isArray(fv) && (fv as unknown[]).includes(c.value);
        }
        return fv === c.value;
      }),
    );
  return {
    where(field: string, op: string, value: unknown) {
      return makeQuery(colPath, [...clauses, { field, op, value }]);
    },
    findNearest(_opts: unknown) {
      return {
        async get() {
          if (findNearestError) throw findNearestError;
          return {
            docs: matches().map(([p, d]) => ({
              id: p.split('/').pop() as string,
              data: () => d,
            })),
          };
        },
      };
    },
    async get() {
      return {
        docs: matches().map(([p, d]) => ({
          id: p.split('/').pop() as string,
          data: () => d,
        })),
      };
    },
  };
}

// When set, doc().set() throws this (simulates a best-effort write failure).
let docSetError: Error | null = null;
const docSetSpy = jest.fn();

const fakeDb = {
  doc: (path: string) => ({
    path,
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    // set(data) replaces; set(data, {merge:true}) shallow-merges (mergeLearnedTags).
    async set(data: Record<string, unknown>, options?: { merge?: boolean }) {
      if (docSetError) throw docSetError;
      const next = options?.merge
        ? { ...(store.get(path) ?? {}), ...data }
        : data;
      store.set(path, next);
      docSetSpy(path, data, options);
    },
  }),
  collection: (path: string) => makeQuery(path, []),
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

// ---- Fake OpenAI + embed --------------------------------------------------

const createQueue: Array<{ message: unknown }> = [];
const mockCreate = jest.fn(async () => {
  const next = createQueue.shift();
  if (!next) throw new Error('createQueue empty — test under-scripted OpenAI');
  return { choices: [next] };
});

jest.mock('../config', () => ({
  getOpenAI: () => ({ chat: { completions: { create: mockCreate } } }),
  MODELS: { reasoning: 'gpt-4o', fast: 'gpt-4o-mini', embedding: 'text-embedding-3-small' },
}));

jest.mock('../tools/embedding', () => ({
  embed: jest.fn(async () => new Array(1536).fill(0)),
}));

import { assignTaskFlow } from '../flows/assignTask';
import { searchMemberCommits, mergeLearnedTags } from '../tools/assignTools';

// ---- Helpers --------------------------------------------------------------

const REPO = 'octocat_hello';

function seedTask(taskId: string, data: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${REPO}/tasks/${taskId}`, {
    title: 't',
    status: 'todo',
    ...data,
  });
}

function seedMember(userId: string, member: Record<string, unknown>, user?: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${REPO}/members/${userId}`, {
    activeIssueCount: 0,
    ...member,
  });
  if (user) store.set(`apps/gitsync/users/${userId}`, user);
}

// Script an assistant turn that calls finalizeAssignment.
function finalizeTurn(
  assigneeId: string,
  reason: string,
  id = 'tc1',
  learnedTags?: string[],
) {
  const args: Record<string, unknown> = { assigneeId, reason };
  if (learnedTags !== undefined) args.learnedTags = learnedTags;
  return {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id,
          type: 'function',
          function: {
            name: 'finalizeAssignment',
            arguments: JSON.stringify(args),
          },
        },
      ],
    },
  };
}

// Script an assistant turn that calls a read tool.
function readToolTurn(name: string, args: Record<string, unknown>, id = 'tc1') {
  return {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
      ],
    },
  };
}

/** The `content` of the user message in the first OpenAI create() call. */
function firstUserMessage(): string {
  const call = mockCreate.mock.calls[0] as unknown[];
  const arg = call[0] as {
    messages: Array<{ role: string; content: string }>;
  };
  return arg.messages.find((m) => m.role === 'user')!.content;
}

beforeEach(() => {
  store.clear();
  createQueue.length = 0;
  mockCreate.mockClear();
  findNearestError = null;
  docSetError = null;
  docSetSpy.mockClear();
});

// ---- Tests ----------------------------------------------------------------

describe('assignTaskFlow pre-checks', () => {
  it('throws not-found when the task is missing', async () => {
    seedMember('u1', {}, { name: 'A' });
    await expect(
      assignTaskFlow({ repoId: REPO, taskId: 'missing' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('throws failed-precondition when the task is already done', async () => {
    seedTask('t1', { status: 'done' });
    seedMember('u1', {}, { name: 'A' });
    await expect(
      assignTaskFlow({ repoId: REPO, taskId: 't1' }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('throws failed-precondition when there are no members', async () => {
    seedTask('t1', {});
    await expect(
      assignTaskFlow({ repoId: REPO, taskId: 't1' }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('assignTaskFlow single-member shortcut', () => {
  it('assigns the only member without calling OpenAI', async () => {
    seedTask('t1', {});
    seedMember('u1', { activeIssueCount: 2 }, { name: 'Solo' });

    const res = await assignTaskFlow({ repoId: REPO, taskId: 't1' });

    expect(res.assigneeId).toBe('u1');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(store.get(`apps/gitsync/repos/${REPO}/tasks/t1`)?.assigneeId).toBe('u1');
    // counter bumped +1
    expect(store.get(`apps/gitsync/repos/${REPO}/members/u1`)?.activeIssueCount).toBe(3);
  });
});

describe('assignTaskFlow agentic loop', () => {
  it('runs a read tool then finalizes, writing assignee + counter', async () => {
    seedTask('t1', {});
    seedMember('u1', { activeIssueCount: 1 }, { name: 'A', githubLogin: 'a' });
    seedMember('u2', { activeIssueCount: 0 }, { name: 'B', githubLogin: 'b' });

    // Round 0: model calls readTeamState. Round 1: model finalizes u2.
    createQueue.push(readToolTurn('readTeamState', {}));
    createQueue.push(finalizeTurn('u2', 'B has the lighter load.'));

    const res = await assignTaskFlow({ repoId: REPO, taskId: 't1' });

    expect(res).toEqual({ assigneeId: 'u2', reasoning: 'B has the lighter load.' });
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(store.get(`apps/gitsync/repos/${REPO}/tasks/t1`)?.assigneeId).toBe('u2');
    expect(store.get(`apps/gitsync/repos/${REPO}/members/u2`)?.activeIssueCount).toBe(1);
    expect(store.get(`apps/gitsync/repos/${REPO}/members/u1`)?.activeIssueCount).toBe(1);
  });

  it('rejects a finalize for a non-member and lets the model retry', async () => {
    seedTask('t1', {});
    seedMember('u1', {}, { name: 'A' });
    seedMember('u2', {}, { name: 'B' });

    createQueue.push(finalizeTurn('ghost', 'nope', 'bad'));
    createQueue.push(finalizeTurn('u1', 'A it is.', 'good'));

    const res = await assignTaskFlow({ repoId: REPO, taskId: 't1' });

    expect(res.assigneeId).toBe('u1');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('reassign: old assignee -1, new assignee +1', async () => {
    seedTask('t1', { assigneeId: 'u1' });
    seedMember('u1', { activeIssueCount: 3 }, { name: 'A' });
    seedMember('u2', { activeIssueCount: 1 }, { name: 'B' });

    createQueue.push(finalizeTurn('u2', 'rebalancing to B.'));

    const res = await assignTaskFlow({ repoId: REPO, taskId: 't1' });

    expect(res.assigneeId).toBe('u2');
    expect(store.get(`apps/gitsync/repos/${REPO}/tasks/t1`)?.assigneeId).toBe('u2');
    expect(store.get(`apps/gitsync/repos/${REPO}/members/u1`)?.activeIssueCount).toBe(2);
    expect(store.get(`apps/gitsync/repos/${REPO}/members/u2`)?.activeIssueCount).toBe(2);
  });
});

describe('assignTaskFlow fallback', () => {
  it('after 5 rounds without finalize, assigns the lowest activeIssueCount member', async () => {
    seedTask('t1', {});
    seedMember('u1', { activeIssueCount: 5 }, { name: 'A' });
    seedMember('u2', { activeIssueCount: 2 }, { name: 'B' }); // lowest
    seedMember('u3', { activeIssueCount: 9 }, { name: 'C' });

    // 5 rounds that only call a read tool, never finalize.
    for (let i = 0; i < 5; i++) {
      createQueue.push(readToolTurn('getTaskDependents', {}, `tc${i}`));
    }

    const res = await assignTaskFlow({ repoId: REPO, taskId: 't1' });

    expect(mockCreate).toHaveBeenCalledTimes(5);
    expect(res.assigneeId).toBe('u2');
    expect(store.get(`apps/gitsync/repos/${REPO}/tasks/t1`)?.assigneeId).toBe('u2');
    expect(store.get(`apps/gitsync/repos/${REPO}/members/u2`)?.activeIssueCount).toBe(3);
  });
});

describe('searchMemberCommits best-effort', () => {
  it('returns [] (does not throw) when findNearest fails with FAILED_PRECONDITION', async () => {
    seedMember('u1', {}, { name: 'A', githubLogin: 'a' });
    // Simulate the live failure: 9 FAILED_PRECONDITION: Missing vector index.
    findNearestError = new Error('9 FAILED_PRECONDITION: Missing vector index configuration');

    await expect(
      searchMemberCommits(REPO, 'u1', 'auth refactor'),
    ).resolves.toEqual([]);
  });

  it('still returns [] for a member without a githubLogin (existing early return)', async () => {
    seedMember('u1', {}, { name: 'A' }); // no githubLogin
    findNearestError = new Error('should never be reached');

    await expect(searchMemberCommits(REPO, 'u1', 'anything')).resolves.toEqual([]);
  });
});

describe('assignTaskFlow resilient to commit search failure', () => {
  it('finalizes via other signals even when searchMemberCommits throws', async () => {
    seedTask('t1', {});
    seedMember('u1', { activeIssueCount: 4 }, { name: 'A', githubLogin: 'a' });
    seedMember('u2', { activeIssueCount: 0 }, { name: 'B', githubLogin: 'b' }); // lighter

    // Missing commit vector index — every findNearest throws.
    findNearestError = new Error('9 FAILED_PRECONDITION: Missing vector index configuration');

    // Round 0: model probes commit history (search will degrade to []).
    // Round 1: model finalizes using workload signal.
    createQueue.push(readToolTurn('searchMemberCommits', { memberId: 'u2', query: 'topic' }));
    createQueue.push(finalizeTurn('u2', 'B has the lighter load; no commit signal available.'));

    const res = await assignTaskFlow({ repoId: REPO, taskId: 't1' });

    expect(res.assigneeId).toBe('u2');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(store.get(`apps/gitsync/repos/${REPO}/tasks/t1`)?.assigneeId).toBe('u2');
    expect(store.get(`apps/gitsync/repos/${REPO}/members/u2`)?.activeIssueCount).toBe(1);
  });
});

// ---- W3b: learnedTags write-back ------------------------------------------

const USERS = (uid: string) => `apps/gitsync/users/${uid}`;

describe('assignTaskFlow learnedTags write-back', () => {
  it('merges learnedTags into the assignee users doc via set(merge)', async () => {
    seedTask('t1', {});
    seedMember('u1', { activeIssueCount: 1 }, { name: 'A' });
    seedMember('u2', { activeIssueCount: 0 }, { name: 'B' });

    createQueue.push(finalizeTurn('u2', 'B fits', 'tc1', ['auth', 'ml']));

    const res = await assignTaskFlow({ repoId: REPO, taskId: 't1' });

    expect(res.assigneeId).toBe('u2');
    expect(store.get(USERS('u2'))?.expertiseTags).toEqual(['auth', 'ml']);
    // Written via set(...,{merge:true}) on the users doc — preserves identity fields.
    expect(docSetSpy).toHaveBeenCalledWith(
      USERS('u2'),
      { expertiseTags: ['auth', 'ml'] },
      { merge: true },
    );
    expect(store.get(USERS('u2'))?.name).toBe('B');
  });

  it('caps merged tags at 8, dropping oldest first', async () => {
    seedTask('t1', {});
    seedMember('u1', { activeIssueCount: 1 }, { name: 'A' });
    seedMember(
      'u2',
      { activeIssueCount: 0 },
      { name: 'B', expertiseTags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7'] },
    );

    // 7 existing + 2 new = 9 → cap to 8, oldest (t1) evicted.
    createQueue.push(finalizeTurn('u2', 'B fits', 'tc1', ['new1', 'new2']));

    await assignTaskFlow({ repoId: REPO, taskId: 't1' });

    expect(store.get(USERS('u2'))?.expertiseTags).toEqual([
      't2', 't3', 't4', 't5', 't6', 't7', 'new1', 'new2',
    ]);
  });

  it('does not write tags when learnedTags is absent', async () => {
    seedTask('t1', {});
    seedMember('u1', { activeIssueCount: 1 }, { name: 'A' });
    seedMember('u2', { activeIssueCount: 0 }, { name: 'B' });

    createQueue.push(finalizeTurn('u2', 'B fits')); // no learnedTags arg

    await assignTaskFlow({ repoId: REPO, taskId: 't1' });

    expect(docSetSpy).not.toHaveBeenCalled();
    expect(store.get(USERS('u2'))?.expertiseTags).toBeUndefined();
  });

  it('best-effort: a tags write failure still returns the assignment', async () => {
    seedTask('t1', {});
    seedMember('u1', { activeIssueCount: 1 }, { name: 'A' });
    seedMember('u2', { activeIssueCount: 0 }, { name: 'B' });

    docSetError = new Error('users write blew up');
    createQueue.push(finalizeTurn('u2', 'B fits', 'tc1', ['auth']));

    const res = await assignTaskFlow({ repoId: REPO, taskId: 't1' });

    expect(res.assigneeId).toBe('u2');
    // Assignment still applied despite the tags write failing.
    expect(store.get(`apps/gitsync/repos/${REPO}/tasks/t1`)?.assigneeId).toBe('u2');
  });
});

describe('mergeLearnedTags', () => {
  it('dedupes + lowercases + trims; writes to users doc with set(merge)', async () => {
    seedMember('u1', {}, { name: 'A', expertiseTags: ['auth'] });

    await mergeLearnedTags(REPO, 'u1', ['Auth', ' ML ', 'ml']);

    expect(store.get(USERS('u1'))?.expertiseTags).toEqual(['auth', 'ml']);
  });

  it('writes via set(merge) even when the users doc is absent', async () => {
    // No users doc seeded for u9.
    await mergeLearnedTags(REPO, 'u9', ['frontend']);

    expect(store.get(USERS('u9'))?.expertiseTags).toEqual(['frontend']);
    expect(docSetSpy).toHaveBeenCalledWith(
      USERS('u9'),
      { expertiseTags: ['frontend'] },
      { merge: true },
    );
  });

  it('no-ops (no write) when there are no usable tags', async () => {
    await mergeLearnedTags(REPO, 'u1', ['  ', '']);
    expect(docSetSpy).not.toHaveBeenCalled();
  });

  it('best-effort: a write failure does not throw', async () => {
    docSetError = new Error('boom');
    await expect(mergeLearnedTags(REPO, 'u1', ['auth'])).resolves.toBeUndefined();
  });
});

// ---- W3a: brief prefix on the assign user message -------------------------

describe('assignTaskFlow project-brief prefix', () => {
  it('prepends the brief block to the user message when a brief exists', async () => {
    seedTask('t1', {});
    seedMember('u1', { activeIssueCount: 1 }, { name: 'A' });
    seedMember('u2', { activeIssueCount: 0 }, { name: 'B' });
    store.set(`apps/gitsync/repos/${REPO}/meta/projectBrief`, {
      content: '- uses OpenAI SDK',
      updatedAt: '__ts__',
      version: 2,
    });

    createQueue.push(finalizeTurn('u2', 'B fits'));

    await assignTaskFlow({ repoId: REPO, taskId: 't1' });

    const userMsg = firstUserMessage();
    expect(userMsg).toMatch(/^## Project memory/);
    expect(userMsg).toContain('- uses OpenAI SDK');
  });

  it('leaves the user message unchanged (no brief block) when no brief exists', async () => {
    seedTask('t1', {});
    seedMember('u1', { activeIssueCount: 1 }, { name: 'A' });
    seedMember('u2', { activeIssueCount: 0 }, { name: 'B' });

    createQueue.push(finalizeTurn('u2', 'B fits'));

    await assignTaskFlow({ repoId: REPO, taskId: 't1' });

    const userMsg = firstUserMessage();
    expect(userMsg).not.toContain('Project memory');
    expect(userMsg.startsWith('repoId:')).toBe(true);
  });
});
