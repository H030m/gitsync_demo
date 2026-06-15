// Unit tests for the two-phase agentic generateHandoffFlow.
//
// Boundary-mock style (like assignTask.test.ts / breakdownTask.test.ts): fake
// Firestore (equality clauses honored; array-contains is a pass-through), a
// scripted OpenAI exposing BOTH chat.completions.create (Phase 1 tool loop) and
// beta.chat.completions.parse (Phase 2 reviewer), and mocked tool helpers. The
// tools/* helpers are mocked so the flow never imports githubClient →
// @octokit/rest (ESM, jest can't parse it).

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
}));

const store = new Map<string, Record<string, unknown>>();
const updateSpy = jest.fn();

const fakeDb = {
  doc: (path: string) => ({
    path,
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    async update(patch: Record<string, unknown>) {
      store.set(path, { ...(store.get(path) ?? {}), ...patch });
      updateSpy(path, patch);
    },
  }),
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

// ---- Scripted OpenAI -------------------------------------------------------
// Phase 1: each create() call returns the next scripted assistant message
// (tool_calls). Phase 2: each parse() call returns the next scripted review.
type ToolCall = { id: string; name: string; args: unknown };
const createQueue: Array<{ toolCalls: ToolCall[] } | { content: string }> = [];
const parseQueue: Array<HandoffReviewLike | null> = [];

interface HandoffReviewLike {
  score: number;
  gaps: string[];
}

const mockCreate = jest.fn(async () => {
  const next = createQueue.shift() ?? { content: null };
  if ('toolCalls' in next) {
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: next.toolCalls.map((t) => ({
              id: t.id,
              type: 'function',
              function: { name: t.name, arguments: JSON.stringify(t.args) },
            })),
          },
        },
      ],
    };
  }
  return {
    choices: [{ message: { role: 'assistant', content: next.content } }],
  };
});

const mockParse = jest.fn(async () => {
  const next = parseQueue.shift();
  return { choices: [{ message: { parsed: next ?? null } }] };
});

jest.mock('../config', () => ({
  getOpenAI: () => ({
    chat: { completions: { create: mockCreate } },
    beta: { chat: { completions: { parse: mockParse } } },
  }),
  MODELS: { reasoning: 'gpt-4o', fast: 'gpt-4o-mini', embedding: 'text-embedding-3-small' },
}));

// ---- Mocked tool helpers (keep @octokit/rest out of the test) --------------
const mockListRelatedCommits = jest.fn(async (..._a: unknown[]) => [
  {
    sha: 'c1c1c1c',
    subject: 'feat: add API endpoint',
    aiSummary: 'Adds the callable.',
    author: 'Bob',
    filesChanged: 1,
  },
]);
const mockGetCommitDiff = jest.fn(async (..._a: unknown[]) => ({
  sha: 'c1c1c1c',
  message: 'feat: add API endpoint',
  files: [
    {
      filename: 'functions/src/handlers/api.ts',
      status: 'added',
      additions: 10,
      deletions: 0,
      patch: '@@ -0,0 +1,10 @@',
    },
  ],
  truncated: false,
}));
jest.mock('../tools/handoffTools', () => ({
  listRelatedCommits: (...a: unknown[]) => mockListRelatedCommits(...a),
  getCommitDiff: (...a: unknown[]) => mockGetCommitDiff(...a),
}));

jest.mock('../tools/dailyIntel', () => ({
  searchPastCommits: jest.fn(async () => []),
}));
jest.mock('../tools/repoDocs', () => ({
  readRepoPlanningDocs: jest.fn(async () => ({ content: '', summary: '', source: 'none', cached: false })),
}));
jest.mock('../tools/discordSearch', () => ({
  searchDiscordMessages: jest.fn(async () => []),
}));
jest.mock('../tools/assignTools', () => ({
  readTeamState: jest.fn(async () => [
    { userId: 'u1', name: 'Alice', githubLogin: 'alice-dev' },
  ]),
}));

// Mock the agent-trace side-channel so the W5 insertion points are observable
// without a real Firestore write (the helper is best-effort + no-op otherwise).
const traceStartRun = jest.fn(async (..._a: unknown[]) => {});
const traceAppendStep = jest.fn(async (..._a: unknown[]) => {});
const traceFinishRun = jest.fn(async (..._a: unknown[]) => {});
jest.mock('../tools/agentTrace', () => ({
  startRun: (...a: unknown[]) => traceStartRun(...a),
  appendStep: (...a: unknown[]) => traceAppendStep(...a),
  finishRun: (...a: unknown[]) => traceFinishRun(...a),
  TRACE_LABELS: {
    listRelatedCommits: 'Listing related commits…',
    readTeamState: 'Reading team roster…',
  },
}));

import { generateHandoffFlow } from '../flows/generateHandoff';

const REPO = 'team17_gitsync';
const TASK = `apps/gitsync/repos/${REPO}/tasks/t-ui`;

// Convenience builders for the scripted queue.
const draftCall = (markdown: string): { toolCalls: ToolCall[] } => ({
  toolCalls: [{ id: 'd1', name: 'draftHandoff', args: { markdown } }],
});
const toolThenNothing = (name: string, args: unknown): { toolCalls: ToolCall[] } => ({
  toolCalls: [{ id: `t-${name}`, name, args }],
});

beforeEach(() => {
  store.clear();
  updateSpy.mockClear();
  mockCreate.mockClear();
  mockParse.mockClear();
  mockListRelatedCommits.mockClear();
  mockGetCommitDiff.mockClear();
  traceStartRun.mockClear();
  traceAppendStep.mockClear();
  traceFinishRun.mockClear();
  createQueue.length = 0;
  parseQueue.length = 0;
});

function seedTasks() {
  store.set(TASK, {
    title: 'Build the task UI',
    description: 'Render the detail page.',
    dependsOn: ['t-api'],
    acceptanceCriteria: ['Renders the list'],
  });
  store.set(`apps/gitsync/repos/${REPO}/tasks/t-api`, {
    title: 'Build the API endpoint',
    description: 'Add the callable.',
    status: 'done',
  });
}

describe('generateHandoffFlow', () => {
  it('throws not-found when the task is missing', async () => {
    await expect(
      generateHandoffFlow({ repoId: REPO, taskId: 'nope' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockParse).not.toHaveBeenCalled();
  });

  it('returns the cached handoffDoc without calling OpenAI (force=false)', async () => {
    store.set(TASK, { title: 'Build the task UI', handoffDoc: 'cached handoff' });

    const res = await generateHandoffFlow({ repoId: REPO, taskId: 't-ui' });

    expect(res).toEqual({ handoffMarkdown: 'cached handoff', cached: true });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockParse).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('force=true regenerates even when a handoffDoc exists', async () => {
    seedTasks();
    store.set(TASK, { ...(store.get(TASK) ?? {}), handoffDoc: 'stale handoff' });
    createQueue.push(draftCall('## What was done\n- Fresh handoff.'));
    parseQueue.push({ score: 5, gaps: [] });

    const res = await generateHandoffFlow({
      repoId: REPO,
      taskId: 't-ui',
      force: true,
    });

    expect(res.cached).toBe(false);
    expect(res.handoffMarkdown).toContain('Fresh handoff');
  });

  it('happy path: first-turn draft → review pass → persists doc + handoffReview', async () => {
    seedTasks();
    createQueue.push(draftCall('## What was done\n- Shipped the API.'));
    parseQueue.push({ score: 5, gaps: [] });

    const res = await generateHandoffFlow({ repoId: REPO, taskId: 't-ui' });

    expect(res.cached).toBe(false);
    expect(res.handoffMarkdown).toContain('What was done');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(
      TASK,
      expect.objectContaining({
        handoffDoc: res.handoffMarkdown,
        handoffGeneratedAt: '__ts__',
        handoffReview: { score: 5, rounds: 1, generatedAt: '__ts__' },
      }),
    );
  });

  it('tool-then-draft: agent calls listRelatedCommits + getCommitDiff, then drafts', async () => {
    seedTasks();
    createQueue.push({
      toolCalls: [
        { id: 'lc', name: 'listRelatedCommits', args: {} },
        { id: 'gd', name: 'getCommitDiff', args: { sha: 'c1c1c1c' } },
      ],
    });
    createQueue.push(draftCall('## What was done\n- Shipped the API (diff read).'));
    parseQueue.push({ score: 5, gaps: [] });

    const res = await generateHandoffFlow({ repoId: REPO, taskId: 't-ui' });

    expect(res.cached).toBe(false);
    expect(mockListRelatedCommits).toHaveBeenCalledWith(REPO, ['t-api', 't-ui']);
    expect(mockGetCommitDiff).toHaveBeenCalledWith(REPO, 'c1c1c1c');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('review-retry: low score injects gaps, agent redrafts, second review passes', async () => {
    seedTasks();
    createQueue.push(draftCall('## What was done\n- thin draft'));
    createQueue.push(draftCall('## What was done\n- improved draft'));
    parseQueue.push({ score: 3, gaps: ['no mention of which file changed'] });
    parseQueue.push({ score: 4, gaps: [] });

    const res = await generateHandoffFlow({ repoId: REPO, taskId: 't-ui' });

    expect(res.handoffMarkdown).toContain('improved draft');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockParse).toHaveBeenCalledTimes(2);

    // The gaps were re-injected into the Phase-1 thread as a user message.
    const secondCallMessages = (
      mockCreate.mock.calls[1] as unknown as [
        { messages: Array<{ role: string; content: string }> },
      ]
    )[0].messages;
    const injected = secondCallMessages.find(
      (m) => m.role === 'user' && m.content.includes('scored 3/5'),
    );
    expect(injected?.content).toContain('no mention of which file changed');

    // retries >= 1 is reflected in the persisted review rounds (2 model turns).
    expect(updateSpy).toHaveBeenCalledWith(
      TASK,
      expect.objectContaining({
        handoffReview: { score: 4, rounds: 2, generatedAt: '__ts__' },
      }),
    );
  });

  it('forced-stop: read tools every round until the cap forces a draftHandoff', async () => {
    seedTasks();
    // Rounds 0-3: keep calling a read tool (never draft). Round 4 (the cap-1
    // round) is forced to draftHandoff by tool_choice — script a draft for it.
    for (let i = 0; i < 4; i++) {
      createQueue.push(toolThenNothing('readTeamState', {}));
    }
    createQueue.push(draftCall('## What was done\n- forced draft'));
    // Even a failing review (score 2) finalizes once the cap is reached.
    parseQueue.push({ score: 2, gaps: ['still thin'] });

    const res = await generateHandoffFlow({ repoId: REPO, taskId: 't-ui' });

    expect(res.handoffMarkdown).toContain('forced draft');
    expect(mockCreate).toHaveBeenCalledTimes(5);
    // The 5th (final) create was forced to draftHandoff via tool_choice.
    const lastCall = mockCreate.mock.calls[4] as unknown as [
      { tool_choice?: { function?: { name?: string } } },
    ];
    expect(lastCall[0].tool_choice?.function?.name).toBe('draftHandoff');
    // Finalized despite score < 4.
    expect(updateSpy).toHaveBeenCalledWith(
      TASK,
      expect.objectContaining({
        handoffReview: { score: 2, rounds: 5, generatedAt: '__ts__' },
      }),
    );
  });

  it('reviewer failure (null parse) is treated as a pass (Q3)', async () => {
    seedTasks();
    createQueue.push(draftCall('## What was done\n- draft'));
    parseQueue.push(null); // reviewer refuses / empty → pass

    const res = await generateHandoffFlow({ repoId: REPO, taskId: 't-ui' });

    expect(res.cached).toBe(false);
    expect(res.handoffMarkdown).toContain('draft');
    expect(updateSpy).toHaveBeenCalledWith(
      TASK,
      expect.objectContaining({
        handoffReview: { score: 4, rounds: 1, generatedAt: '__ts__' },
      }),
    );
  });

  it('draftHandoff precedence: a draft + read tool in one turn finalizes the draft (Q6)', async () => {
    seedTasks();
    createQueue.push({
      toolCalls: [
        { id: 'lc', name: 'listRelatedCommits', args: {} },
        { id: 'd1', name: 'draftHandoff', args: { markdown: '## What was done\n- both' } },
      ],
    });
    parseQueue.push({ score: 5, gaps: [] });

    const res = await generateHandoffFlow({ repoId: REPO, taskId: 't-ui' });

    expect(res.handoffMarkdown).toContain('both');
    // draftHandoff won → the read tool was NOT executed this turn.
    expect(mockListRelatedCommits).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('traces the run (W5): startRun → appendStep per tool round + review → finishRun', async () => {
    seedTasks();
    // One tool round, then a draft, then a passing review.
    createQueue.push(toolThenNothing('listRelatedCommits', {}));
    createQueue.push(draftCall('## What was done\n- Shipped.'));
    parseQueue.push({ score: 5, gaps: [] });

    await generateHandoffFlow({ repoId: REPO, taskId: 't-ui', runId: 'run-h1' });

    expect(traceStartRun).toHaveBeenCalledWith(REPO, 'run-h1', 'generateHandoff');
    // appendStep called for the tool round AND for the review verdict.
    expect(traceAppendStep).toHaveBeenCalledWith(REPO, 'run-h1', ['Listing related commits…']);
    expect(traceAppendStep).toHaveBeenCalledWith(REPO, 'run-h1', 'Reviewing draft (score 5/5)…');
    expect(traceFinishRun).toHaveBeenCalledWith(REPO, 'run-h1', 'done');
  });

  it('does not open a trace run for a cached handoff (W5)', async () => {
    store.set(TASK, { title: 'Build the task UI', handoffDoc: 'cached handoff' });
    await generateHandoffFlow({ repoId: REPO, taskId: 't-ui', runId: 'run-h2' });
    expect(traceStartRun).not.toHaveBeenCalled();
  });

  it('throws internal when the draft markdown is empty', async () => {
    seedTasks();
    createQueue.push(draftCall(''));

    await expect(
      generateHandoffFlow({ repoId: REPO, taskId: 't-ui' }),
    ).rejects.toMatchObject({ code: 'internal' });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // ---- W6: regenerate in the app language ----------------------------------
  // The system content of each phase is read straight off the scripted calls:
  // Phase 1 from mockCreate (chat.completions.create), Phase 2 from mockParse
  // (beta.chat.completions.parse).
  const phase1System = (callIdx = 0): string =>
    (
      mockCreate.mock.calls[callIdx] as unknown as [
        { messages: Array<{ role: string; content: string }> },
      ]
    )[0].messages.find((m) => m.role === 'system')?.content ?? '';
  const phase2System = (callIdx = 0): string =>
    (
      mockParse.mock.calls[callIdx] as unknown as [
        { messages: Array<{ role: string; content: string }> },
      ]
    )[0].messages.find((m) => m.role === 'system')?.content ?? '';

  it('language present → the directive reaches BOTH phase system prompts', async () => {
    seedTasks();
    createQueue.push(draftCall('## What was done\n- 完成 API。'));
    parseQueue.push({ score: 5, gaps: [] });

    await generateHandoffFlow({
      repoId: REPO,
      taskId: 't-ui',
      force: true,
      language: 'Traditional Chinese',
    });

    const expectedLine = 'Write your entire response in Traditional Chinese.';
    expect(phase1System()).toContain(expectedLine);
    expect(phase2System()).toContain(expectedLine);
  });

  it('language absent → phase system prompts are byte-identical to a present run minus the line', async () => {
    // Baseline run WITHOUT language.
    seedTasks();
    createQueue.push(draftCall('## What was done\n- Shipped.'));
    parseQueue.push({ score: 5, gaps: [] });
    await generateHandoffFlow({ repoId: REPO, taskId: 't-ui', force: true });
    const baseP1 = phase1System();
    const baseP2 = phase2System();

    // No language directive at all.
    expect(baseP1).not.toContain('Write your entire response in');
    expect(baseP2).not.toContain('Write your entire response in');

    // A run WITH language appends exactly the one line to each base prompt.
    mockCreate.mockClear();
    mockParse.mockClear();
    createQueue.push(draftCall('## What was done\n- Shipped.'));
    parseQueue.push({ score: 5, gaps: [] });
    await generateHandoffFlow({
      repoId: REPO,
      taskId: 't-ui',
      force: true,
      language: 'English',
    });
    expect(phase1System()).toBe(`${baseP1}\n\n---\n\nWrite your entire response in English.`);
    expect(phase2System()).toBe(`${baseP2}\n\n---\n\nWrite your entire response in English.`);
  });

  it('empty/whitespace language → byte-identical prompt (no directive)', async () => {
    seedTasks();
    createQueue.push(draftCall('## What was done\n- Shipped.'));
    parseQueue.push({ score: 5, gaps: [] });
    await generateHandoffFlow({
      repoId: REPO,
      taskId: 't-ui',
      force: true,
      language: '   ',
    });
    expect(phase1System()).not.toContain('Write your entire response in');
    expect(phase2System()).not.toContain('Write your entire response in');
  });
});
