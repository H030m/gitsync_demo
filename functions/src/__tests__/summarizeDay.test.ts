// Unit tests for summarizeDayFlow (agentic daily report).
//
// Boundary mocks (assignTask.test.ts style):
//   - firebase-functions/v2 → logger no-op
//   - firebase-functions/v2/https → HttpsError (dailyIntel path may surface it)
//   - firebase-admin/firestore → FieldValue.serverTimestamp + Timestamp.fromMillis
//   - ../admin → hand-rolled fake Firestore honoring '==' clauses, ignoring
//     range/orderBy/limit (date filtering lives in taipeiDayBounds, tested in
//     discordDailyDigest.test.ts)
//   - ../config → getOpenAI scripted per-test

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
  // taipeiRangeBounds compares bounds via toMillis().
  Timestamp: { fromMillis: (ms: number) => ({ __ms__: ms, toMillis: () => ms }) },
}));

// ---- Fake Firestore -------------------------------------------------------

const store = new Map<string, Record<string, unknown>>();
const setSpy = jest.fn();

function childDocsOf(colPath: string): Array<[string, Record<string, unknown>]> {
  return [...store.entries()].filter(
    ([p]) =>
      p.startsWith(`${colPath}/`) &&
      p.slice(colPath.length + 1).indexOf('/') === -1,
  );
}

interface WhereClause {
  field: string;
  op: string;
  value: unknown;
}

function makeQuery(colPath: string, clauses: WhereClause[]) {
  const matches = () =>
    childDocsOf(colPath).filter(([, d]) =>
      // Honor equality only; ignore range bounds (date math tested elsewhere).
      clauses.every((c) => (c.op === '==' ? d[c.field] === c.value : true)),
    );
  const q = {
    where(field: string, op: string, value: unknown) {
      return makeQuery(colPath, [...clauses, { field, op, value }]);
    },
    orderBy() {
      return q;
    },
    limit() {
      return q;
    },
    async get() {
      return {
        empty: matches().length === 0,
        size: matches().length,
        docs: matches().map(([p, d]) => ({
          id: p.split('/').pop() as string,
          data: () => d,
        })),
      };
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
    async set(data: Record<string, unknown>) {
      store.set(path, data);
      setSpy(path, data);
    },
  }),
  collection: (path: string) => makeQuery(path, []),
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

// ---- Fake OpenAI ----------------------------------------------------------

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

// W3a: mock the project-brief module so existing report assertions are untouched
// (mergeProjectBrief becomes a no-op here; the brief logic itself is covered in
// projectBrief.test.ts). We still assert the flow invokes it with the report.
const mockMergeProjectBrief = jest.fn(
  async (_repoId: string, _reportText: string) => undefined,
);
jest.mock('../tools/projectBrief', () => ({
  mergeProjectBrief: (repoId: string, reportText: string) =>
    mockMergeProjectBrief(repoId, reportText),
  renderReportForBrief: (r: { summary: string }) => `RENDERED:${r.summary}`,
}));

import { summarizeDayFlow } from '../flows/summarizeDay';

// ---- Helpers --------------------------------------------------------------

const REPO = 'team17_gitsync';
const DATE = '2026-06-04';

function seedCommit(sha: string, data: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${REPO}/commits/${sha}`, {
    message: 'commit',
    author: { login: 'x', name: 'X' },
    committedAt: { __ms__: 0 },
    ...data,
  });
}
function seedTask(id: string, data: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${REPO}/tasks/${id}`, {
    title: 't',
    status: 'done',
    updatedAt: { __ms__: 0 },
    ...data,
  });
}
function seedMember(uid: string, user: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${REPO}/members/${uid}`, { activeIssueCount: 0 });
  store.set(`apps/gitsync/users/${uid}`, user);
}

function finalizeTurn(args: Record<string, unknown>, id = 'tc1') {
  return {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id,
          type: 'function',
          function: { name: 'finalizeReport', arguments: JSON.stringify(args) },
        },
      ],
    },
  };
}
function toolTurn(name: string, args: Record<string, unknown>, id = 'tc1') {
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

const NARRATIVE = {
  summary: 'Auth landed; daily report UI started.',
  highlights: ['GitHub OAuth wired'],
  blockers: [],
  commitThemes: [{ theme: 'Auth', summary: 'OAuth provider added.', commitCount: 2 }],
};

beforeEach(() => {
  store.clear();
  createQueue.length = 0;
  mockCreate.mockClear();
  setSpy.mockClear();
  mockMergeProjectBrief.mockClear();
});

// ---- Tests ----------------------------------------------------------------

describe('summarizeDayFlow', () => {
  it('finalizes the narrative and writes the report with deterministic counts', async () => {
    seedMember('alice', { name: 'Alice', githubLogin: 'alice-dev' });
    seedMember('bob', { name: 'Bob', githubLogin: 'bob-ml' });
    seedCommit('c1', { author: { login: 'alice-dev', name: 'Alice' } });
    seedCommit('c2', { author: { login: 'alice-dev', name: 'Alice' } });
    seedCommit('c3', { author: { login: 'bob-ml', name: 'Bob' } });
    // Author with no roster match — bucketed under the login itself.
    seedCommit('c4', { author: { login: 'drive-by', name: 'Stranger' } });
    seedTask('t1', { assigneeId: 'alice', title: 'OAuth' });

    createQueue.push(finalizeTurn(NARRATIVE));

    const res = await summarizeDayFlow({ repoId: REPO, startDate: DATE, endDate: DATE });

    expect(res.summary).toBe(NARRATIVE.summary);
    expect(res.commitCount).toBe(4);
    expect(res.completedTaskIds).toEqual(['t1']);
    // Counts are computed in TS (login → userId), not taken from the LLM.
    // Names are resolved from the roster at generation time (PRD D3).
    expect(res.memberContributions).toEqual({
      alice: {
        tasksDone: 1,
        commits: 2,
        githubLogin: 'alice-dev',
        displayName: 'Alice',
      },
      bob: { tasksDone: 0, commits: 1, githubLogin: 'bob-ml', displayName: 'Bob' },
      'drive-by': {
        tasksDone: 0,
        commits: 1,
        githubLogin: 'drive-by',
        displayName: 'drive-by',
      },
    });

    // Report persisted at dailyReports/{date}.
    const path = `apps/gitsync/repos/${REPO}/dailyReports/${DATE}`;
    expect(setSpy).toHaveBeenCalledWith(path, expect.objectContaining({
      date: DATE,
      summary: NARRATIVE.summary,
      commitCount: 4,
      generatedAt: '__ts__',
    }));
  });

  it('lets the agent read the digest before finalizing', async () => {
    seedMember('alice', { name: 'Alice', githubLogin: 'alice-dev' });
    seedCommit('c1', { author: { login: 'alice-dev', name: 'Alice' } });
    store.set(`apps/gitsync/repos/${REPO}/discordDigests/${DATE}`, {
      date: DATE,
      markdown: 'Blocker: callback URL on Windows.',
      messageCount: 3,
    });

    // Round 0: read digest. Round 1: finalize using it.
    createQueue.push(toolTurn('listRangeDigests', {}));
    createQueue.push(
      finalizeTurn({ ...NARRATIVE, blockers: ['callback URL on Windows'] }),
    );

    const res = await summarizeDayFlow({ repoId: REPO, startDate: DATE, endDate: DATE });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(res.blockers).toEqual(['callback URL on Windows']);
  });

  it('falls back to a deterministic summary if the agent never finalizes', async () => {
    seedCommit('c1', { author: { login: 'x', name: 'X' } });
    seedTask('t1', { assigneeId: 'x', title: 'Did a thing' });

    // 4 rounds (MAX_ROUNDS) that only read, never finalize.
    for (let i = 0; i < 4; i++) createQueue.push(toolTurn('listRangeDigests', {}, `tc${i}`));

    const res = await summarizeDayFlow({ repoId: REPO, startDate: DATE, endDate: DATE });

    expect(res.summary).toContain('1 commit');
    expect(res.highlights).toEqual(['Completed: Did a thing']);
    expect(setSpy).toHaveBeenCalled();
  });

  it('clamps negative/garbage commitCount from the model', async () => {
    seedCommit('c1', { author: { login: 'x', name: 'X' } });
    createQueue.push(
      finalizeTurn({
        ...NARRATIVE,
        commitThemes: [{ theme: 'A', summary: 's', commitCount: -3 }],
      }),
    );

    const res = await summarizeDayFlow({ repoId: REPO, startDate: DATE, endDate: DATE });
    expect(res.commitThemes[0].commitCount).toBe(0);
  });

  it('writes a multi-day report under {start}_{end} with both range fields', async () => {
    seedCommit('c1', { author: { login: 'x', name: 'X' } });
    createQueue.push(finalizeTurn(NARRATIVE));

    const res = await summarizeDayFlow({
      repoId: REPO,
      startDate: '2026-06-01',
      endDate: '2026-06-04',
    });

    expect(res.startDate).toBe('2026-06-01');
    expect(res.endDate).toBe('2026-06-04');
    const path =
      `apps/gitsync/repos/${REPO}/dailyReports/2026-06-01_2026-06-04`;
    expect(setSpy).toHaveBeenCalledWith(
      path,
      expect.objectContaining({
        date: '2026-06-01_2026-06-04',
        startDate: '2026-06-01',
        endDate: '2026-06-04',
      }),
    );
  });

  it('rolls the project brief (best-effort) after persisting the report', async () => {
    seedCommit('c1', { author: { login: 'x', name: 'X' } });
    createQueue.push(finalizeTurn(NARRATIVE));

    await summarizeDayFlow({ repoId: REPO, startDate: DATE, endDate: DATE });

    // Invoked once with the repoId + the rendered report text.
    expect(mockMergeProjectBrief).toHaveBeenCalledTimes(1);
    expect(mockMergeProjectBrief).toHaveBeenCalledWith(
      REPO,
      `RENDERED:${NARRATIVE.summary}`,
    );
  });

  it('still returns the report when the brief merge throws (best-effort)', async () => {
    seedCommit('c1', { author: { login: 'x', name: 'X' } });
    mockMergeProjectBrief.mockRejectedValueOnce(new Error('brief blew up'));
    createQueue.push(finalizeTurn(NARRATIVE));

    const res = await summarizeDayFlow({ repoId: REPO, startDate: DATE, endDate: DATE });

    expect(res.summary).toBe(NARRATIVE.summary);
    expect(setSpy).toHaveBeenCalled(); // report persisted regardless
  });

  // ---- W6: regenerate the narrative in the app language ---------------------
  // The system message of the narrative agent is read off the scripted create().
  const narrativeSystem = (callIdx = 0): string =>
    (
      mockCreate.mock.calls[callIdx] as unknown as [
        { messages: Array<{ role: string; content: string }> },
      ]
    )[0].messages.find((m) => m.role === 'system')?.content ?? '';

  it('language present → the narrative system prompt carries the directive', async () => {
    seedCommit('c1', { author: { login: 'x', name: 'X' } });
    createQueue.push(finalizeTurn(NARRATIVE));

    await summarizeDayFlow({
      repoId: REPO,
      startDate: DATE,
      endDate: DATE,
      language: 'Traditional Chinese',
    });

    expect(narrativeSystem()).toContain(
      'Write your entire response in Traditional Chinese.',
    );
  });

  it('language absent → narrative system prompt is byte-identical to base', async () => {
    seedCommit('c1', { author: { login: 'x', name: 'X' } });
    createQueue.push(finalizeTurn(NARRATIVE));
    await summarizeDayFlow({ repoId: REPO, startDate: DATE, endDate: DATE });
    const base = narrativeSystem();
    expect(base).not.toContain('Write your entire response in');

    // A WITH-language run appends exactly one line to that same base.
    mockCreate.mockClear();
    createQueue.push(finalizeTurn(NARRATIVE));
    await summarizeDayFlow({
      repoId: REPO,
      startDate: DATE,
      endDate: DATE,
      language: 'English',
    });
    expect(narrativeSystem()).toBe(
      `${base}\n\n---\n\nWrite your entire response in English.`,
    );
  });
});
