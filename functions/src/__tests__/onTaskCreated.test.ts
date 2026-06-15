// Unit tests for the onTaskCreated trigger (mirrors a task as a GitHub issue).
//
// Boundary mocks (testing-guidelines.md):
//   - firebase-functions/v2/firestore → onDocumentCreated returns the raw
//     handler so we invoke it directly with a fake event.
//   - firebase-functions/v2 → logger no-op.
//   - ../admin → hand-rolled fake Firestore (doc/get/update).
//   - ../services/githubClient → createIssue mocked (GitHub boundary).
//   - ../tools/idempotency → markIdempotent mocked.

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: (_opts: unknown, handler: unknown) => handler,
}));

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockMarkIdempotent = jest.fn();
jest.mock('../tools/idempotency', () => ({
  markIdempotent: (...args: unknown[]) => mockMarkIdempotent(...args),
}));

const mockCreateIssue = jest.fn();
jest.mock('../services/githubClient', () => ({
  createIssue: (...args: unknown[]) => mockCreateIssue(...args),
}));

// ---- Fake Firestore -------------------------------------------------------

const store = new Map<string, Record<string, unknown>>();

function makeDocRef(path: string) {
  return {
    path,
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    async update(patch: Record<string, unknown>) {
      store.set(path, { ...(store.get(path) ?? {}), ...patch });
    },
  };
}

const fakeDb = { doc: (path: string) => makeDocRef(path) };

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

import { onTaskCreated } from '../triggers/onTaskCreated';

const REPO_ID = 'octocat_hello';
const TASK_ID = 'task1';

const handler = onTaskCreated as unknown as (event: unknown) => Promise<void>;

function makeEvent(task: Record<string, unknown>, id = 'evt-1') {
  store.set(`apps/gitsync/repos/${REPO_ID}/tasks/${TASK_ID}`, task);
  return {
    id,
    params: { repoId: REPO_ID, taskId: TASK_ID },
    data: { data: () => store.get(`apps/gitsync/repos/${REPO_ID}/tasks/${TASK_ID}`) },
  };
}

beforeEach(() => {
  store.clear();
  mockMarkIdempotent.mockReset().mockResolvedValue(true);
  mockCreateIssue.mockReset();
  store.set(`apps/gitsync/repos/${REPO_ID}`, { name: 'octocat/hello' });
  store.set('apps/gitsync/users/u1', { githubAccessToken: 'tok' });
});

describe('onTaskCreated', () => {
  it('creates a GitHub issue and stores the number on the task', async () => {
    mockCreateIssue.mockResolvedValue({ number: 42, htmlUrl: 'url' });
    const event = makeEvent({ title: 'Do X', description: 'details', createdBy: 'u1' });

    await handler(event);

    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    const [owner, repo, token, opts] = mockCreateIssue.mock.calls[0];
    expect(owner).toBe('octocat');
    expect(repo).toBe('hello');
    expect(token).toBe('tok');
    expect((opts as { title: string }).title).toBe('Do X');
    expect((opts as { body: string }).body).toContain(TASK_ID);

    const task = store.get(`apps/gitsync/repos/${REPO_ID}/tasks/${TASK_ID}`);
    expect(task?.githubIssueNumber).toBe(42);
  });

  it('skips when the task already has githubIssueNumber', async () => {
    const event = makeEvent({ title: 'Do X', createdBy: 'u1', githubIssueNumber: 7 });
    await handler(event);
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('best-effort: no token → skip, no crash, number stays null', async () => {
    store.delete('apps/gitsync/users/u1');
    const event = makeEvent({ title: 'Do X', createdBy: 'u1' });
    await handler(event);
    expect(mockCreateIssue).not.toHaveBeenCalled();
    const task = store.get(`apps/gitsync/repos/${REPO_ID}/tasks/${TASK_ID}`);
    expect(task?.githubIssueNumber).toBeUndefined();
  });

  it('best-effort: createIssue throws → no number written, no throw', async () => {
    mockCreateIssue.mockRejectedValue(new Error('boom'));
    const event = makeEvent({ title: 'Do X', createdBy: 'u1' });
    await expect(handler(event)).resolves.toBeUndefined();
    const task = store.get(`apps/gitsync/repos/${REPO_ID}/tasks/${TASK_ID}`);
    expect(task?.githubIssueNumber).toBeUndefined();
  });

  it('duplicate delivery (markIdempotent→false) → no-op', async () => {
    mockMarkIdempotent.mockResolvedValue(false);
    const event = makeEvent({ title: 'Do X', createdBy: 'u1' });
    await handler(event);
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });
});
