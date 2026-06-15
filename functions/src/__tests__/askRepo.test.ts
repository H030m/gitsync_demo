// Unit tests for askRepoFlow (the unified repo-wide "ask anything" agent).
//
// Boundary-mock style (like dailyBriefChat.test.ts): fake Firestore (equality
// clauses honored, ranges ignored), scripted OpenAI, no-op logger. The
// agent-trace side-channel, repoDocs (→ octokit), and assignTools are mocked so
// we can assert trace cadence and keep ESM-only deps out of the test.

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

// ---- Scripted OpenAI -------------------------------------------------------
const createQueue: Array<{ message: unknown }> = [];
const mockCreate = jest.fn(async () => {
  const next = createQueue.shift();
  if (!next) throw new Error('createQueue empty — test under-scripted OpenAI');
  return { choices: [next] };
});

// Planner pre-step uses openai.beta.chat.completions.parse. Default to a null
// plan → empty guidance → the main loop / system prompt is unchanged (so the
// existing assertions hold). A test can push a plan to exercise the planner.
const planQueue: Array<{ parsed: unknown }> = [];
const mockPlan = jest.fn(async () => ({
  choices: [{ message: { parsed: planQueue.shift()?.parsed ?? null } }],
}));

jest.mock('../config', () => ({
  getOpenAI: () => ({
    chat: { completions: { create: mockCreate } },
    beta: { chat: { completions: { parse: mockPlan } } },
  }),
  MODELS: { reasoning: 'gpt-4o', fast: 'gpt-4o-mini', embedding: 'text-embedding-3-small' },
}));

// ---- Mocked tools (keep octokit out; control discord/roster results) -------
const mockSearchDiscord = jest.fn(async (..._a: unknown[]) => [] as unknown[]);
jest.mock('../tools/discordSearch', () => ({
  searchDiscordMessages: (...a: unknown[]) => mockSearchDiscord(...a),
}));
jest.mock('../tools/repoDocs', () => ({
  readRepoPlanningDocs: jest.fn(async () => ({ content: 'PLAN', summary: '', source: 'none', cached: false })),
}));
jest.mock('../tools/assignTools', () => ({
  getTaskDependents: jest.fn(async () => [{ taskId: 't9', title: 'Blocked task' }]),
  readTeamState: jest.fn(async () => [
    { userId: 'u1', name: 'Alice', githubLogin: 'alice-dev' },
  ]),
}));
// handoffTools pulls in githubClient → @octokit/rest (ESM jest can't parse);
// mock it so getCommitDiff is scriptable and octokit stays out of the test.
const mockGetCommitDiff = jest.fn(async (..._a: unknown[]) => null as unknown);
jest.mock('../tools/handoffTools', () => ({
  getCommitDiff: (...a: unknown[]) => mockGetCommitDiff(...a),
}));

// ---- Mocked agent-trace (assert cadence) -----------------------------------
const startRun = jest.fn(async (..._a: unknown[]) => {});
const appendStep = jest.fn(async (..._a: unknown[]) => {});
const finishRun = jest.fn(async (..._a: unknown[]) => {});
jest.mock('../tools/agentTrace', () => ({
  startRun: (...a: unknown[]) => startRun(...a),
  appendStep: (...a: unknown[]) => appendStep(...a),
  finishRun: (...a: unknown[]) => finishRun(...a),
  TRACE_LABELS: {
    listDayCommits: 'Listing recent commits…',
    searchPastCommits: 'Searching commit history…',
    searchDiscordMessages: 'Searching Discord…',
    getCommitDiff: 'Reading a commit diff…',
    composing: 'Composing answer…',
  },
}));

import { askRepoFlow } from '../flows/askRepo';

const REPO = 'team17_gitsync';

function seedCommit(sha: string, data: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${REPO}/commits/${sha}`, {
    message: 'commit',
    author: { login: 'x', name: 'X' },
    committedAt: { __ms__: 0 },
    ...data,
  });
}
/** The `system` message content of the Nth main-loop OpenAI create() call. */
function systemMessageOf(n: number): string {
  const arg = (mockCreate.mock.calls[n] as unknown[])[0] as {
    messages: Array<{ role: string; content: string }>;
  };
  return arg.messages.find((m) => m.role === 'system')!.content;
}

function toolTurn(calls: Array<{ name: string; args?: Record<string, unknown>; id?: string }>) {
  return {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((c, i) => ({
        id: c.id ?? `tc${i}`,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
    },
  };
}
function answerTurn(content: string) {
  return { message: { role: 'assistant', content, tool_calls: [] } };
}
/** The `messages` array passed to the first OpenAI create() call. */
function firstCallMessages(): Array<{ role: string; content: string }> {
  const call = mockCreate.mock.calls[0] as unknown as [
    { messages: Array<{ role: string; content: string }> },
  ];
  return call[0].messages;
}

beforeEach(() => {
  store.clear();
  createQueue.length = 0;
  planQueue.length = 0;
  mockPlan.mockClear();
  mockCreate.mockClear();
  mockSearchDiscord.mockClear();
  mockSearchDiscord.mockResolvedValue([]);
  startRun.mockClear();
  appendStep.mockClear();
  finishRun.mockClear();
});

describe('askRepoFlow', () => {
  it('answers immediately with no tools (empty sources)', async () => {
    createQueue.push(answerTurn('Ask me about commits, tasks, code or chat.'));
    const res = await askRepoFlow({ repoId: REPO, question: 'hi' });
    expect(res.answer).toContain('Ask me about');
    expect(res.commits).toEqual([]);
    expect(res.snippets).toEqual([]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('listDayCommits surfaces commits deduped by sha (first-seen order)', async () => {
    seedCommit('c1', { message: 'Add OAuth', author: { login: 'a', name: 'Alice' } });
    seedCommit('c2', { message: 'Fix lint', author: { login: 'b', name: 'Bob' } });
    // Two rounds both call listDayCommits → same commits, must dedupe.
    createQueue.push(toolTurn([{ name: 'listDayCommits' }]));
    createQueue.push(toolTurn([{ name: 'listDayCommits' }]));
    createQueue.push(answerTurn('Two commits landed.'));

    const res = await askRepoFlow({ repoId: REPO, question: 'what landed?' });
    expect(res.commits.map((c) => c.sha).sort()).toEqual(['c1', 'c2']);
    expect(res.answer).toContain('Two commits');
  });

  it('splits per-author listDayCommits calls into labeled windows', async () => {
    seedCommit('c1', { message: 'A work', author: { login: 'alice', name: 'Alice' } });
    seedCommit('c2', { message: 'B work', author: { login: 'bob', name: 'Bob' } });
    // One round, two author-filtered calls → two labeled windows.
    createQueue.push(toolTurn([
      { name: 'listDayCommits', args: { authorLogin: 'alice' } },
      { name: 'listDayCommits', args: { authorLogin: 'bob' } },
    ]));
    createQueue.push(answerTurn('Per person.'));

    const res = await askRepoFlow({ repoId: REPO, question: 'who did what?' });
    expect(res.commitGroups.map((g) => g.label).sort()).toEqual(['Alice', 'Bob']);
    const alice = res.commitGroups.find((g) => g.label === 'Alice');
    expect(alice?.commits.map((c) => c.sha)).toEqual(['c1']);
    // The flat `commits` field is the union of every window (backward compat).
    expect(res.commits.map((c) => c.sha).sort()).toEqual(['c1', 'c2']);
  });

  it('matches authorLogin fuzzily (partial login / suffix)', async () => {
    // The user says "opal" but the real login carries a suffix.
    seedCommit('c1', { message: 'merge', author: { login: 'opaL1022', name: 'Opal' } });
    seedCommit('c2', { message: 'other', author: { login: 'bob', name: 'Bob' } });
    createQueue.push(toolTurn([{ name: 'listDayCommits', args: { authorLogin: 'opal' } }]));
    createQueue.push(answerTurn('found it'));

    const res = await askRepoFlow({ repoId: REPO, question: "opal's merge?" });
    // Only opaL1022's commit, labeled by display name; bob excluded.
    expect(res.commitGroups).toHaveLength(1);
    expect(res.commitGroups[0].label).toBe('Opal');
    expect(res.commitGroups[0].commits.map((c) => c.sha)).toEqual(['c1']);
  });

  it('injects the planner interpretation into the system prompt as guidance', async () => {
    planQueue.push({
      parsed: {
        intent: 'What did Opal merge into main recently?',
        people: ['opal'],
        taskHints: [],
        searchTopics: ['merge develop into main'],
        timeWindowDays: 7,
      },
    });
    createQueue.push(answerTurn('done'));

    await askRepoFlow({ repoId: REPO, question: 'opal 剛剛 merge 了啥' });

    expect(mockPlan).toHaveBeenCalledTimes(1);
    expect(systemMessageOf(0)).toContain('Interpretation of the question');
    expect(systemMessageOf(0)).toContain('opal');
    expect(systemMessageOf(0)).toContain('days=7');
  });

  it('planner failure leaves the flow working (no guidance block)', async () => {
    // null plan → empty guidance → system prompt has no interpretation block.
    createQueue.push(answerTurn('still works'));
    const res = await askRepoFlow({ repoId: REPO, question: 'hi' });
    expect(res.answer).toBe('still works');
    expect(systemMessageOf(0)).not.toContain('Interpretation of the question');
  });

  it('surfaces committedAt as an ISO string from the commit timestamp', async () => {
    seedCommit('c1', { committedAt: { _seconds: 1718200000 } });
    createQueue.push(toolTurn([{ name: 'listDayCommits' }]));
    createQueue.push(answerTurn('done'));

    const res = await askRepoFlow({ repoId: REPO, question: 'recent?' });
    expect(res.commits[0].committedAt).toBe(new Date(1718200000 * 1000).toISOString());
  });

  it('searchDiscordMessages snippets are collected and deduped by snippetKey', async () => {
    const snip = {
      channelId: 'ch1',
      messages: [
        { messageId: 'm1', channelId: 'ch1', authorName: 'A', content: 'hi', isMatch: true, timestamp: null },
        { messageId: 'm2', channelId: 'ch1', authorName: 'B', content: 'yo', isMatch: false, timestamp: null },
      ],
      score: 1,
    };
    mockSearchDiscord.mockResolvedValue([snip]);
    // Two search rounds return the SAME snippet → one surfaced source.
    createQueue.push(toolTurn([{ name: 'searchDiscordMessages', args: { query: 'oauth' } }]));
    createQueue.push(toolTurn([{ name: 'searchDiscordMessages', args: { query: 'oauth again' } }]));
    createQueue.push(answerTurn('Found a discussion.'));

    const res = await askRepoFlow({ repoId: REPO, question: 'what was discussed?' });
    expect(res.snippets).toHaveLength(1);
    expect(res.snippets[0].channelId).toBe('ch1');
  });

  it('aggregates mixed-tool sources across rounds in first-seen order', async () => {
    seedCommit('c1', { message: 'Add OAuth' });
    mockSearchDiscord.mockResolvedValue([
      { channelId: 'ch1', messages: [{ messageId: 'm1', channelId: 'ch1', authorName: 'A', content: 'x', isMatch: true, timestamp: null }], score: 1 },
    ]);
    createQueue.push(toolTurn([
      { name: 'listDayCommits' },
      { name: 'searchDiscordMessages', args: { query: 'oauth' } },
    ]));
    createQueue.push(answerTurn('Here is what I found.'));

    const res = await askRepoFlow({ repoId: REPO, question: 'oauth?' });
    expect(res.commits.map((c) => c.sha)).toEqual(['c1']);
    expect(res.snippets.map((s) => s.channelId)).toEqual(['ch1']);
  });

  it('forces a final no-tools answer after MAX_ROUNDS', async () => {
    seedCommit('c1', {});
    for (let i = 0; i < 5; i++) createQueue.push(toolTurn([{ name: 'listDayCommits', id: `r${i}` }]));
    createQueue.push(answerTurn('Final summary.'));

    const res = await askRepoFlow({ repoId: REPO, question: 'summary?' });
    expect(res.answer).toContain('Final summary');
    // 5 tool rounds + 1 forced final answer.
    expect(mockCreate).toHaveBeenCalledTimes(6);
  });

  it('clamps a model-requested days window to <= 92 and respects it', async () => {
    seedCommit('c1', {});
    createQueue.push(toolTurn([{ name: 'listDayCommits', args: { days: 999 } }]));
    createQueue.push(answerTurn('done'));
    await askRepoFlow({ repoId: REPO, question: 'all time?' });
    // The flow ran without throwing on an out-of-range window (clamped).
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('includes the projectBrief as a stable system prefix when present', async () => {
    store.set(`apps/gitsync/repos/${REPO}/meta/projectBrief`, {
      content: 'We use MVVM and asia-east1.',
      version: 3,
    });
    createQueue.push(answerTurn('ok'));
    await askRepoFlow({ repoId: REPO, question: 'conventions?' });
    const sys = firstCallMessages()[0];
    expect(sys.role).toBe('system');
    expect(sys.content).toContain('Project memory');
    expect(sys.content).toContain('We use MVVM');
  });

  it('leaves the system prompt unchanged when the brief is empty', async () => {
    createQueue.push(answerTurn('ok'));
    await askRepoFlow({ repoId: REPO, question: 'hi' });
    const sys = firstCallMessages()[0];
    expect(sys.content).not.toContain('Project memory');
  });

  it('threads history (<=8 turns) before the question', async () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `turn ${i}`,
    }));
    createQueue.push(answerTurn('ok'));
    await askRepoFlow({ repoId: REPO, question: 'now?', history });
    const msgs = firstCallMessages();
    const contents = msgs.map((m) => m.content);
    // Only the last 8 turns are replayed: the oldest two are dropped.
    expect(contents).not.toContain('turn 0');
    expect(contents).not.toContain('turn 1');
    expect(contents).toContain('turn 2');
    expect(contents).toContain('turn 9');
    expect(msgs[0].role).toBe('system');
    // The question is the last item replayed before any tool round.
    expect(contents).toContain('now?');
  });

  it('with a runId: calls startRun → appendStep(per round) → finishRun(done)', async () => {
    seedCommit('c1', {});
    createQueue.push(toolTurn([{ name: 'listDayCommits' }]));
    createQueue.push(answerTurn('done'));

    await askRepoFlow({ repoId: REPO, question: 'q', runId: 'run-1' });
    expect(startRun).toHaveBeenCalledWith(REPO, 'run-1', 'askRepo');
    expect(appendStep).toHaveBeenCalledTimes(1); // one round of tools
    expect(appendStep).toHaveBeenCalledWith(REPO, 'run-1', ['Listing recent commits…']);
    expect(finishRun).toHaveBeenCalledWith(REPO, 'run-1', 'done');
  });

  it('without a runId still calls the (no-op) trace helpers; result unchanged', async () => {
    createQueue.push(answerTurn('ok'));
    const res = await askRepoFlow({ repoId: REPO, question: 'q' });
    expect(res.answer).toBe('ok');
    expect(startRun).toHaveBeenCalledWith(REPO, undefined, 'askRepo');
    expect(finishRun).toHaveBeenCalledWith(REPO, undefined, 'done');
  });

  it('marks the run errored when the flow throws (then rethrows for the handler)', async () => {
    // No scripted completion → OpenAI mock throws → flow rejects.
    await expect(
      askRepoFlow({ repoId: REPO, question: 'q', runId: 'run-x' }),
    ).rejects.toThrow();
    expect(finishRun).toHaveBeenCalledWith(REPO, 'run-x', 'error');
  });
});
