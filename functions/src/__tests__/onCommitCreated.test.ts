// Unit tests for the onCommitCreated trigger (link + embed + summarize).
//
// Boundary mocks:
//   - firebase-functions/v2/firestore → onDocumentCreated returns raw handler.
//   - firebase-functions/v2 → logger no-op.
//   - firebase-admin/firestore → FieldValue.vector sentinel.
//   - ../admin → fake Firestore (doc/update + collection/where/get).
//   - ../config → getOpenAI with mocked chat.completions.create; MODELS.
//   - ../tools/embedding → embedToFieldValue mocked.
//   - ../tools/idempotency → markIdempotent mocked.

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: (_opts: unknown, handler: unknown) => handler,
}));

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { vector: (v: number[]) => ({ __vector__: v }) },
}));

const mockMarkIdempotent = jest.fn();
jest.mock('../tools/idempotency', () => ({
  markIdempotent: (...args: unknown[]) => mockMarkIdempotent(...args),
}));

const mockEmbed = jest.fn();
jest.mock('../tools/embedding', () => ({
  embedToFieldValue: (...args: unknown[]) => mockEmbed(...args),
}));

const mockChatCreate = jest.fn();
jest.mock('../config', () => ({
  getOpenAI: () => ({ chat: { completions: { create: mockChatCreate } } }),
  MODELS: { reasoning: 'gpt-4o', fast: 'gpt-4o-mini', embedding: 'text-embedding-3-small' },
  openaiKey: { value: () => 'k' },
}));

// ---- Fake Firestore -------------------------------------------------------

const store = new Map<string, Record<string, unknown>>();
// task docs keyed by id under the tasks collection, for the where() query.
const tasks = new Map<string, Record<string, unknown>>();

const REPO_ID = 'octocat_hello';
const SHA = 'abc123';
const COMMIT_PATH = `apps/gitsync/repos/${REPO_ID}/commits/${SHA}`;
const TASKS_PATH = `apps/gitsync/repos/${REPO_ID}/tasks`;

function makeDocRef(path: string) {
  return {
    path,
    async update(patch: Record<string, unknown>) {
      store.set(path, { ...(store.get(path) ?? {}), ...patch });
    },
  };
}

const fakeDb = {
  doc: (path: string) => makeDocRef(path),
  collection: (path: string) => ({
    where: (field: string, _op: string, value: unknown) => ({
      async get() {
        const docs = [...tasks.entries()]
          .filter(([, d]) => d[field] === value)
          .map(([id]) => ({ id }));
        return { docs };
      },
    }),
    _path: path,
  }),
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

import { onCommitCreated } from '../triggers/onCommitCreated';

const handler = onCommitCreated as unknown as (event: unknown) => Promise<void>;

function makeEvent(message: string, id = 'evt-1') {
  store.set(COMMIT_PATH, { repoId: REPO_ID, sha: SHA, message });
  return {
    id,
    params: { repoId: REPO_ID, sha: SHA },
    data: { data: () => store.get(COMMIT_PATH) },
  };
}

beforeEach(() => {
  store.clear();
  tasks.clear();
  mockMarkIdempotent.mockReset().mockResolvedValue(true);
  mockEmbed.mockReset().mockResolvedValue({ __vector__: [0.1, 0.2] });
  mockChatCreate
    .mockReset()
    .mockResolvedValue({ choices: [{ message: { content: 'A summary.' } }] });
  void TASKS_PATH;
});

describe('onCommitCreated', () => {
  it('links #N → linkedTaskIds, writes embedding + aiSummary', async () => {
    tasks.set('taskA', { githubIssueNumber: 3 });
    const event = makeEvent('fix login closes #3');

    await handler(event);

    const commit = store.get(COMMIT_PATH);
    expect(commit?.linkedTaskIds).toEqual(['taskA']);
    expect(commit?.messageEmbedding).toEqual({ __vector__: [0.1, 0.2] });
    expect(commit?.aiSummary).toBe('A summary.');
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    expect(mockChatCreate.mock.calls[0][0].model).toBe('gpt-4o-mini');
  });

  it('empty linkedTaskIds when no task matches the ref', async () => {
    const event = makeEvent('fix login #99');
    await handler(event);
    expect(store.get(COMMIT_PATH)?.linkedTaskIds).toEqual([]);
  });

  it('skip-embedding path: links but no embedding/summary', async () => {
    tasks.set('taskA', { githubIssueNumber: 3 });
    const event = makeEvent('Merge branch main #3');

    await handler(event);

    const commit = store.get(COMMIT_PATH);
    expect(commit?.linkedTaskIds).toEqual(['taskA']);
    expect(commit?.messageEmbedding).toBeUndefined();
    expect(commit?.aiSummary).toBeUndefined();
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('best-effort: aiSummary failure leaves field unset, still writes link', async () => {
    mockChatCreate.mockRejectedValue(new Error('openai down'));
    const event = makeEvent('fix bug');
    await expect(handler(event)).resolves.toBeUndefined();
    const commit = store.get(COMMIT_PATH);
    expect(commit?.aiSummary).toBeUndefined();
    expect(commit?.messageEmbedding).toEqual({ __vector__: [0.1, 0.2] });
  });

  it('duplicate delivery → no-op', async () => {
    mockMarkIdempotent.mockResolvedValue(false);
    const event = makeEvent('fix login closes #3');
    await handler(event);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });
});
