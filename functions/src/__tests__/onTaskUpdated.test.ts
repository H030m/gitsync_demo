// Unit tests for onTaskUpdated (auto-assign downstream + FCM notify on done).
//
// Boundary mocks:
//   - firebase-functions/v2/firestore → onDocumentUpdated returns raw handler.
//   - firebase-functions/v2 → logger no-op.
//   - firebase-admin/messaging → getMessaging().send mocked (FCM boundary).
//   - ../admin → fake Firestore (doc/get + collection/where('array-contains')/get).
//   - ../config → openaiKey stub (trigger only references it for `secrets:`).
//   - ../flows/assignTask → assignTaskFlow mocked.
//   - ../tools/idempotency → markIdempotent mocked.

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentUpdated: (_opts: unknown, handler: unknown) => handler,
}));

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockSend = jest.fn();
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: () => ({ send: (...args: unknown[]) => mockSend(...args) }),
}));

const mockAssignTaskFlow = jest.fn();
jest.mock('../flows/assignTask', () => ({
  assignTaskFlow: (...args: unknown[]) => mockAssignTaskFlow(...args),
}));

const mockGenerateHandoff = jest.fn();
jest.mock('../flows/generateHandoff', () => ({
  generateHandoffFlow: (...args: unknown[]) => mockGenerateHandoff(...args),
}));

const mockSetIssueAssignees = jest.fn();
jest.mock('../services/githubClient', () => ({
  setIssueAssignees: (...args: unknown[]) => mockSetIssueAssignees(...args),
}));

const mockMarkIdempotent = jest.fn();
jest.mock('../tools/idempotency', () => ({
  markIdempotent: (...args: unknown[]) => mockMarkIdempotent(...args),
}));

jest.mock('../config', () => ({ openaiKey: { value: () => 'sk-test' } }));

// ---- Fake Firestore -------------------------------------------------------

const store = new Map<string, Record<string, unknown>>();

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
    where: (field: string, op: string, value: unknown) => ({
      async get() {
        const docs = [...store.entries()]
          .filter(
            ([p]) =>
              p.startsWith(`${path}/`) &&
              p.slice(path.length + 1).indexOf('/') === -1,
          )
          .filter(([, d]) => {
            if (op === 'array-contains') {
              return Array.isArray(d[field]) && (d[field] as unknown[]).includes(value);
            }
            return d[field] === value;
          })
          .map(([p, d]) => ({ id: p.split('/').pop() as string, data: () => d }));
        return { docs };
      },
    }),
  }),
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

import { onTaskUpdated } from '../triggers/onTaskUpdated';

const REPO_ID = 'octocat_hello';
const handler = onTaskUpdated as unknown as (event: unknown) => Promise<void>;

function makeEvent(
  beforeStatus: string | undefined,
  afterStatus: string | undefined,
  taskId = 'A',
  id = 'evt-1',
) {
  return {
    id,
    params: { repoId: REPO_ID, taskId },
    data: {
      before: { data: () => (beforeStatus === undefined ? undefined : { status: beforeStatus }) },
      after: { data: () => (afterStatus === undefined ? undefined : { status: afterStatus }) },
    },
  };
}

function seedTask(id: string, data: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${REPO_ID}/tasks/${id}`, data);
}
function seedUser(uid: string, data: Record<string, unknown>) {
  store.set(`apps/gitsync/users/${uid}`, data);
}

function seedRepo(data: Record<string, unknown>) {
  store.set(`apps/gitsync/repos/${REPO_ID}`, data);
}

beforeEach(() => {
  store.clear();
  mockMarkIdempotent.mockReset().mockResolvedValue(true);
  mockSend.mockReset().mockResolvedValue('msg-id');
  mockAssignTaskFlow.mockReset();
  mockGenerateHandoff.mockReset().mockResolvedValue({
    handoffMarkdown: 'handoff',
    cached: false,
  });
  mockSetIssueAssignees.mockReset().mockResolvedValue(undefined);
});

describe('onTaskUpdated', () => {
  it('unassigned ready downstream → assignTaskFlow called + FCM sent', async () => {
    seedTask('A', { status: 'done', title: 'A' });
    seedTask('B', { status: 'todo', title: 'Build UI', dependsOn: ['A'] });
    mockAssignTaskFlow.mockResolvedValue({ assigneeId: 'u1', reasoning: 'x' });
    seedUser('u1', { fcmToken: 'tok-1' });

    await handler(makeEvent('in_progress', 'done', 'A'));

    expect(mockAssignTaskFlow).toHaveBeenCalledWith({ repoId: REPO_ID, taskId: 'B' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'tok-1',
        notification: { title: '有新任務可以開始了', body: 'Build UI' },
      }),
    );
  });

  it('FCM title is localized to the recipient locale (en)', async () => {
    seedTask('A', { status: 'done', title: 'A' });
    seedTask('B', { status: 'todo', title: 'Build UI', dependsOn: ['A'] });
    mockAssignTaskFlow.mockResolvedValue({ assigneeId: 'u1', reasoning: 'x' });
    seedUser('u1', { fcmToken: 'tok-1', locale: 'en' });

    await handler(makeEvent('in_progress', 'done', 'A'));

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'tok-1',
        notification: { title: 'A new task is ready to start', body: 'Build UI' },
      }),
    );
  });

  it('already-assigned ready downstream → no assignTaskFlow, but FCM still sent', async () => {
    seedTask('A', { status: 'done', title: 'A' });
    seedTask('B', { status: 'todo', title: 'B', dependsOn: ['A'], assigneeId: 'u2' });
    seedUser('u2', { fcmToken: 'tok-2' });

    await handler(makeEvent('in_progress', 'done', 'A'));

    expect(mockAssignTaskFlow).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-2' }));
  });

  it('ready filter: downstream with an unfinished other prereq is skipped', async () => {
    seedTask('A', { status: 'done', title: 'A' });
    seedTask('C', { status: 'in_progress', title: 'C' }); // other prereq, not done
    seedTask('B', { status: 'todo', title: 'B', dependsOn: ['A', 'C'] });

    await handler(makeEvent('in_progress', 'done', 'A'));

    expect(mockAssignTaskFlow).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('all prereqs done → downstream is processed', async () => {
    seedTask('A', { status: 'done', title: 'A' });
    seedTask('C', { status: 'done', title: 'C' });
    seedTask('B', { status: 'todo', title: 'B', dependsOn: ['A', 'C'], assigneeId: 'u1' });
    seedUser('u1', { fcmToken: 'tok-1' });

    await handler(makeEvent('in_progress', 'done', 'A'));

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('missing fcmToken → no send, no throw', async () => {
    seedTask('A', { status: 'done', title: 'A' });
    seedTask('B', { status: 'todo', title: 'B', dependsOn: ['A'], assigneeId: 'u3' });
    // u3 has no fcmToken (no user doc at all)

    await handler(makeEvent('in_progress', 'done', 'A'));

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('one downstream throwing → other downstream still processed', async () => {
    seedTask('A', { status: 'done', title: 'A' });
    seedTask('B1', { status: 'todo', title: 'B1', dependsOn: ['A'] });
    seedTask('B2', { status: 'todo', title: 'B2', dependsOn: ['A'], assigneeId: 'u9' });
    seedUser('u9', { fcmToken: 'tok-9' });
    // B1 (unassigned) → assignTaskFlow throws; B2 (assigned) → must still notify.
    mockAssignTaskFlow.mockRejectedValue(new Error('OpenAI down'));

    await expect(handler(makeEvent('in_progress', 'done', 'A'))).resolves.toBeUndefined();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-9' }));
  });

  it('non-transition (assigneeId-only change, still in_progress) → no action / no recursion', async () => {
    seedTask('A', { status: 'in_progress', title: 'A' });
    seedTask('B', { status: 'todo', title: 'B', dependsOn: ['A'] });

    await handler(makeEvent('in_progress', 'in_progress', 'A'));

    expect(mockAssignTaskFlow).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('todo → in_progress is a no-op', async () => {
    seedTask('B', { status: 'todo', title: 'B', dependsOn: ['A'] });
    await handler(makeEvent('todo', 'in_progress', 'A'));
    expect(mockAssignTaskFlow).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('already done → done (re-fire) → no action', async () => {
    seedTask('B', { status: 'todo', title: 'B', dependsOn: ['A'] });
    await handler(makeEvent('done', 'done', 'A'));
    expect(mockAssignTaskFlow).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('duplicate delivery → no-op', async () => {
    mockMarkIdempotent.mockResolvedValue(false);
    seedTask('A', { status: 'done', title: 'A' });
    seedTask('B', { status: 'todo', title: 'B', dependsOn: ['A'] });
    await handler(makeEvent('in_progress', 'done', 'A'));
    expect(mockAssignTaskFlow).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('deletion (no after) → no-op', async () => {
    await handler(makeEvent('in_progress', undefined, 'A'));
    expect(mockAssignTaskFlow).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('ready downstream → AI handoff generated before notify', async () => {
    seedTask('A', { status: 'done', title: 'A' });
    seedTask('B', { status: 'todo', title: 'Build UI', dependsOn: ['A'], assigneeId: 'u1' });
    seedUser('u1', { fcmToken: 'tok-1' });

    await handler(makeEvent('in_progress', 'done', 'A'));

    expect(mockGenerateHandoff).toHaveBeenCalledWith({
      repoId: REPO_ID,
      taskId: 'B',
      force: false,
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('handoff generation failure does not block the notify', async () => {
    seedTask('A', { status: 'done', title: 'A' });
    seedTask('B', { status: 'todo', title: 'B', dependsOn: ['A'], assigneeId: 'u1' });
    seedUser('u1', { fcmToken: 'tok-1' });
    mockGenerateHandoff.mockRejectedValue(new Error('OpenAI down'));

    await expect(handler(makeEvent('in_progress', 'done', 'A'))).resolves.toBeUndefined();

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('assignee change with a linked issue → GitHub issue assignee synced', async () => {
    seedRepo({ name: 'octocat/hello' });
    seedUser('creator', { githubAccessToken: 'ght' });
    seedUser('u1', { githubLogin: 'alice-dev' });

    const event = {
      id: 'evt-assign',
      params: { repoId: REPO_ID, taskId: 'A' },
      data: {
        before: {
          data: () => ({
            status: 'in_progress',
            githubIssueNumber: 7,
            createdBy: 'creator',
          }),
        },
        after: {
          data: () => ({
            status: 'in_progress',
            assigneeId: 'u1',
            githubIssueNumber: 7,
            createdBy: 'creator',
          }),
        },
      },
    };

    await handler(event);

    expect(mockSetIssueAssignees).toHaveBeenCalledWith(
      'octocat',
      'hello',
      'ght',
      7,
      ['alice-dev'],
    );
    // status stayed in_progress → no downstream processing
    expect(mockAssignTaskFlow).not.toHaveBeenCalled();
  });

  it('assignee change without a linked issue → no GitHub sync', async () => {
    const event = {
      id: 'evt-noissue',
      params: { repoId: REPO_ID, taskId: 'A' },
      data: {
        before: { data: () => ({ status: 'in_progress', createdBy: 'creator' }) },
        after: {
          data: () => ({ status: 'in_progress', assigneeId: 'u1', createdBy: 'creator' }),
        },
      },
    };

    await handler(event);

    expect(mockSetIssueAssignees).not.toHaveBeenCalled();
  });
});
