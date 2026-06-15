// Unit tests for breakdownTaskFlow + detectCycles.
//
// Boundary mocks (same style as addRepo.test.ts):
//   - firebase-functions/v2/https → HttpsError captures `code`.
//   - firebase-functions/v2 → logger no-op.
//   - firebase-admin/firestore → FieldValue.serverTimestamp sentinel.
//   - ../admin → hand-rolled fake Firestore (doc/get/collection/batch).
//   - ../config → getOpenAI returns a mock whose parse() is queued per-test.
//   - ../prompts/breakdownTask → real prompts are fine; left unmocked.

// ---- Mocks ----------------------------------------------------------------

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
    serverTimestamp: () => '__serverTimestamp__',
  },
}));

// ---- Fake Firestore -------------------------------------------------------
//
// store: docPath -> data. A collection's doc() with no id auto-generates a
// monotonic id so tests can predict them (`t0`, `t1`, ...). doc(id) targets a
// specific path. batch.set() records writes, applied on commit().

interface FakeDoc {
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
}

const store = new Map<string, Record<string, unknown>>();
const batchWrites: Array<{ path: string; data: Record<string, unknown> }> = [];
let idCounter = 0;

function makeDocRef(path: string) {
  return {
    path,
    id: path.split('/').pop() as string,
    async get(): Promise<FakeDoc> {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
  };
}

function makeCollectionRef(basePath: string) {
  return {
    doc: (id?: string) => {
      const docId = id ?? `t${idCounter++}`;
      return makeDocRef(`${basePath}/${docId}`);
    },
  };
}

const fakeDb = {
  doc: (path: string) => makeDocRef(path),
  collection: (path: string) => makeCollectionRef(path),
  batch: () => ({
    set(ref: { path: string }, data: Record<string, unknown>) {
      batchWrites.push({ path: ref.path, data });
    },
    async commit() {
      for (const w of batchWrites) store.set(w.path, w.data);
    },
  }),
};

jest.mock('../admin', () => ({
  db: fakeDb,
  REGION: 'asia-east1',
}));

// ---- Fake OpenAI ----------------------------------------------------------

const parseQueue: Array<{ parsed: unknown }> = [];
const mockParse = jest.fn(async () => {
  const next = parseQueue.shift();
  return { choices: [{ message: { parsed: next?.parsed ?? null } }] };
});

jest.mock('../config', () => ({
  getOpenAI: () => ({ beta: { chat: { completions: { parse: mockParse } } } }),
  MODELS: { reasoning: 'gpt-4o', fast: 'gpt-4o-mini', embedding: 'text-embedding-3-small' },
}));

// zodResponseFormat from openai pulls in zod; keep it but it's harmless. The
// real helper is used so the call shape matches production.

// Mock tools/repoDocs so the flow's Step-1 call is scriptable per test and the
// test never pulls in githubClient → @octokit/rest (ESM, jest can't parse it).
let repoDocsResult: {
  content: string;
  summary: string;
  source: string;
  cached: boolean;
} = { content: '', summary: 'no GitHub docs available', source: 'none', cached: false };
const mockReadRepoPlanningDocs = jest.fn((_repoId: string) =>
  Promise.resolve(repoDocsResult),
);
jest.mock('../tools/repoDocs', () => ({
  readRepoPlanningDocs: (repoId: string) => mockReadRepoPlanningDocs(repoId),
}));

// Import after mocks.
import { breakdownTaskFlow, detectCycles } from '../flows/breakdownTask';

function seedRepo(repoId: string, data: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${repoId}`, data);
}

/** The `content` of the user message in the first OpenAI parse() call. */
function firstUserMessage(): string {
  const call = mockParse.mock.calls[0] as unknown[];
  const arg = call[0] as {
    messages: Array<{ role: string; content: string }>;
  };
  return arg.messages.find((m) => m.role === 'user')!.content;
}

beforeEach(() => {
  store.clear();
  batchWrites.length = 0;
  parseQueue.length = 0;
  idCounter = 0;
  mockParse.mockClear();
  mockReadRepoPlanningDocs.mockClear();
  repoDocsResult = { content: '', summary: 'no GitHub docs available', source: 'none', cached: false };
});

// ---- detectCycles ---------------------------------------------------------

describe('detectCycles', () => {
  it('returns [] for an acyclic graph', () => {
    expect(
      detectCycles([
        { dependsOn: [] },
        { dependsOn: [0] },
        { dependsOn: [0, 1] },
      ]),
    ).toEqual([]);
  });

  it('detects a direct 2-node cycle', () => {
    const cycles = detectCycles([{ dependsOn: [1] }, { dependsOn: [0] }]);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it('detects a self-loop', () => {
    const cycles = detectCycles([{ dependsOn: [0] }]);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it('ignores out-of-range indices', () => {
    expect(detectCycles([{ dependsOn: [5, -1] }])).toEqual([]);
  });
});

// ---- breakdownTaskFlow ----------------------------------------------------

describe('breakdownTaskFlow', () => {
  it('throws not-found when the repo doc is missing', async () => {
    await expect(
      breakdownTaskFlow({ repoId: 'x_y', goal: 'spec', requestedBy: 'u1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('throws internal when the model returns no parsed output', async () => {
    seedRepo('x_y', { name: 'x/y' });
    parseQueue.push({ parsed: null });
    await expect(
      breakdownTaskFlow({ repoId: 'x_y', goal: 'spec', requestedBy: 'u1' }),
    ).rejects.toMatchObject({ code: 'internal' });
  });

  it('happy path: writes N task docs with source ai_breakdown', async () => {
    seedRepo('x_y', { name: 'x/y', description: 'a demo' });
    parseQueue.push({
      parsed: {
        subtasks: [
          { title: 'A', description: 'da', dependsOn: [], estimatedHours: 2 },
          { title: 'B', description: 'db', dependsOn: [0], estimatedHours: 3 },
        ],
      },
    });

    const res = await breakdownTaskFlow({
      repoId: 'x_y',
      goal: 'spec',
      requestedBy: 'u1',
    });

    expect(res.subtasks).toHaveLength(2);
    expect(mockParse).toHaveBeenCalledTimes(1);

    const docA = store.get('apps/gitsync/repos/x_y/tasks/t0');
    const docB = store.get('apps/gitsync/repos/x_y/tasks/t1');
    expect(docA).toMatchObject({
      title: 'A',
      status: 'todo',
      source: 'ai_breakdown',
      createdBy: 'u1',
      parentTaskId: null,
      dependsOn: [],
      estimatedHours: 2,
    });
    expect(docA?.createdAt).toBe('__serverTimestamp__');
    expect(docB).toMatchObject({ title: 'B', source: 'ai_breakdown' });
  });

  it('prepends readRepoPlanningDocs content to the OpenAI context and drops the "newly imported" line', async () => {
    seedRepo('x_y', { name: 'x/y', description: 'a demo' });
    repoDocsResult = {
      content: '## Project progress (.trellis)\n\n3 tasks — done 2 / in_progress 1 / todo 0',
      summary: '2/3 tasks done; 1 open',
      source: 'trellis',
      cached: false,
    };
    parseQueue.push({ parsed: { subtasks: [] } });

    await breakdownTaskFlow({ repoId: 'x_y', goal: 'spec', requestedBy: 'u1' });

    expect(mockReadRepoPlanningDocs).toHaveBeenCalledWith('x_y');
    const userMsg = firstUserMessage();
    expect(userMsg).toContain('## Project progress (.trellis)');
    expect(userMsg).not.toContain('This is a newly imported project');
  });

  it('keeps the "newly imported" line when no planning docs are found', async () => {
    seedRepo('x_y', { name: 'x/y' });
    // repoDocsResult defaults to the empty none result.
    parseQueue.push({ parsed: { subtasks: [] } });

    await breakdownTaskFlow({ repoId: 'x_y', goal: 'spec', requestedBy: 'u1' });

    expect(firstUserMessage()).toContain('This is a newly imported project');
  });

  it('prepends the project brief at the top of the context when one exists (W3a)', async () => {
    seedRepo('x_y', { name: 'x/y' });
    store.set('apps/gitsync/repos/x_y/meta/projectBrief', {
      content: '- uses OpenAI SDK, not Genkit',
      updatedAt: '__serverTimestamp__',
      version: 3,
    });
    parseQueue.push({ parsed: { subtasks: [] } });

    await breakdownTaskFlow({ repoId: 'x_y', goal: 'spec', requestedBy: 'u1' });

    const userMsg = firstUserMessage();
    // Brief block sits at the very top of projectContext (stable cache prefix).
    expect(userMsg).toContain('## Project memory');
    expect(userMsg).toContain('- uses OpenAI SDK, not Genkit');
    expect(userMsg.indexOf('## Project memory')).toBeLessThan(
      userMsg.indexOf('Repository: x/y'),
    );
  });

  it('leaves the context unchanged when no project brief exists (W3a)', async () => {
    seedRepo('x_y', { name: 'x/y' });
    parseQueue.push({ parsed: { subtasks: [] } });

    await breakdownTaskFlow({ repoId: 'x_y', goal: 'spec', requestedBy: 'u1' });

    expect(firstUserMessage()).not.toContain('Project memory');
  });

  it('translates dependsOn 0-based indices into real taskIds', async () => {
    seedRepo('x_y', { name: 'x/y' });
    parseQueue.push({
      parsed: {
        subtasks: [
          { title: 'A', description: '', dependsOn: [], estimatedHours: 1 },
          { title: 'B', description: '', dependsOn: [0], estimatedHours: 1 },
          { title: 'C', description: '', dependsOn: [0, 1], estimatedHours: 1 },
        ],
      },
    });

    const res = await breakdownTaskFlow({
      repoId: 'x_y',
      goal: 'spec',
      requestedBy: 'u1',
    });

    const idA = res.subtasks[0].id;
    const idB = res.subtasks[1].id;
    expect(res.subtasks[1].dependsOn).toEqual([idA]);
    expect(res.subtasks[2].dependsOn).toEqual([idA, idB]);

    // Persisted docs carry the translated string ids, not the indices.
    const docC = store.get(`apps/gitsync/repos/x_y/tasks/${res.subtasks[2].id}`);
    expect(docC?.dependsOn).toEqual([idA, idB]);
  });

  it('drops out-of-range dependsOn indices', async () => {
    seedRepo('x_y', { name: 'x/y' });
    parseQueue.push({
      parsed: {
        subtasks: [
          { title: 'A', description: '', dependsOn: [9, -1], estimatedHours: 1 },
        ],
      },
    });
    const res = await breakdownTaskFlow({
      repoId: 'x_y',
      goal: 'spec',
      requestedBy: 'u1',
    });
    expect(res.subtasks[0].dependsOn).toEqual([]);
  });

  it('re-prompts once on a cycle, succeeds when the retry is acyclic', async () => {
    seedRepo('x_y', { name: 'x/y' });
    // First parse: cyclic (0<->1). Second parse: acyclic.
    parseQueue.push({
      parsed: {
        subtasks: [
          { title: 'A', description: '', dependsOn: [1], estimatedHours: 1 },
          { title: 'B', description: '', dependsOn: [0], estimatedHours: 1 },
        ],
      },
    });
    parseQueue.push({
      parsed: {
        subtasks: [
          { title: 'A', description: '', dependsOn: [], estimatedHours: 1 },
          { title: 'B', description: '', dependsOn: [0], estimatedHours: 1 },
        ],
      },
    });

    const res = await breakdownTaskFlow({
      repoId: 'x_y',
      goal: 'spec',
      requestedBy: 'u1',
    });

    expect(mockParse).toHaveBeenCalledTimes(2);
    expect(res.subtasks).toHaveLength(2);
    expect(res.subtasks[0].dependsOn).toEqual([]);
    expect(res.subtasks[1].dependsOn).toEqual([res.subtasks[0].id]);
  });

  it('throws internal when the model is cyclic twice', async () => {
    seedRepo('x_y', { name: 'x/y' });
    const cyclic = {
      parsed: {
        subtasks: [
          { title: 'A', description: '', dependsOn: [1], estimatedHours: 1 },
          { title: 'B', description: '', dependsOn: [0], estimatedHours: 1 },
        ],
      },
    };
    parseQueue.push(cyclic);
    parseQueue.push(cyclic);

    await expect(
      breakdownTaskFlow({ repoId: 'x_y', goal: 'spec', requestedBy: 'u1' }),
    ).rejects.toMatchObject({ code: 'internal' });
    expect(mockParse).toHaveBeenCalledTimes(2);
  });
});
