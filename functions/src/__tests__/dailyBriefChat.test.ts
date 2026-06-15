// Unit tests for dailyBriefChatFlow ("ask AI about today" agent).
//
// Same boundary-mock style as summarizeDay.test.ts: fake Firestore (equality
// clauses honored, ranges ignored), scripted OpenAI, no-op logger.

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

const store = new Map<string, Record<string, unknown>>();

function childDocsOf(colPath: string): Array<[string, Record<string, unknown>]> {
  return [...store.entries()].filter(
    ([p]) =>
      p.startsWith(`${colPath}/`) &&
      p.slice(colPath.length + 1).indexOf('/') === -1,
  );
}

function makeQuery(colPath: string, clauses: Array<{ field: string; op: string; value: unknown }>) {
  const matches = () =>
    childDocsOf(colPath).filter(([, d]) =>
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
  }),
  collection: (path: string) => makeQuery(path, []),
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

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

// handoffTools pulls in githubClient → @octokit/rest (ESM jest can't parse);
// mock it so getCommitDiff is scriptable and octokit stays out of the test.
const mockGetCommitDiff = jest.fn(async (..._a: unknown[]) => null as unknown);
jest.mock('../tools/handoffTools', () => ({
  getCommitDiff: (...a: unknown[]) => mockGetCommitDiff(...a),
}));

import { dailyBriefChatFlow } from '../flows/dailyBriefChat';

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
function answerTurn(content: string) {
  return { message: { role: 'assistant', content, tool_calls: [] } };
}

beforeEach(() => {
  store.clear();
  createQueue.length = 0;
  mockCreate.mockClear();
});

describe('dailyBriefChatFlow', () => {
  it('calls a tool then answers, returning surfaced commits (deduped by sha)', async () => {
    seedCommit('c1', { message: 'Add OAuth', author: { login: 'a', name: 'Alice' } });
    seedCommit('c2', { message: 'Fix lint', author: { login: 'b', name: 'Bob' } });

    createQueue.push(toolTurn('listDayCommits', {}));
    createQueue.push(answerTurn('Two commits landed: OAuth and a lint fix.'));

    const res = await dailyBriefChatFlow({
      repoId: REPO,
      date: DATE,
      question: 'What landed today?',
    });

    expect(res.answer).toContain('Two commits');
    expect(res.commits.map((c) => c.sha).sort()).toEqual(['c1', 'c2']);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('answers immediately when the model needs no tools', async () => {
    createQueue.push(answerTurn('Ask me about commits, tasks, or blockers.'));
    const res = await dailyBriefChatFlow({
      repoId: REPO,
      date: DATE,
      question: 'hi',
    });
    expect(res.answer).toContain('Ask me about');
    expect(res.commits).toEqual([]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('forces a final answer after the round limit', async () => {
    seedCommit('c1', {});
    // 4 rounds (MAX_ROUNDS) of tool calls, never a plain answer...
    for (let i = 0; i < 4; i++) createQueue.push(toolTurn('listDayCommits', {}, `tc${i}`));
    // ...then the forced no-tools final call.
    createQueue.push(answerTurn('Here is the summary you asked for.'));

    const res = await dailyBriefChatFlow({
      repoId: REPO,
      date: DATE,
      question: 'summary?',
    });

    expect(res.answer).toContain('summary');
    expect(mockCreate).toHaveBeenCalledTimes(5);
  });
});
