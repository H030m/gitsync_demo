// Unit tests for onTaskDeleted (close the mirrored GitHub issue on task delete).

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentDeleted: (_opts: unknown, handler: unknown) => handler,
}));
jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCloseIssue = jest.fn();
jest.mock('../services/githubClient', () => ({
  closeIssue: (...a: unknown[]) => mockCloseIssue(...a),
}));

const mockMarkIdempotent = jest.fn();
jest.mock('../tools/idempotency', () => ({
  markIdempotent: (...a: unknown[]) => mockMarkIdempotent(...a),
}));

const store = new Map<string, Record<string, unknown>>();
const fakeDb = {
  doc: (path: string) => ({
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
  }),
};
jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

import { onTaskDeleted } from '../triggers/onTaskDeleted';

const REPO = 'octocat_hello';
const handler = onTaskDeleted as unknown as (e: unknown) => Promise<void>;

function event(taskData: Record<string, unknown> | undefined, id = 'evt-1') {
  return {
    id,
    params: { repoId: REPO, taskId: 'T' },
    data: taskData === undefined ? undefined : { data: () => taskData },
  };
}

beforeEach(() => {
  store.clear();
  mockMarkIdempotent.mockReset().mockResolvedValue(true);
  mockCloseIssue.mockReset().mockResolvedValue(undefined);
  store.set(`apps/gitsync/repos/${REPO}`, { name: 'octocat/hello' });
  store.set('apps/gitsync/users/creator', { githubAccessToken: 'ght' });
});

describe('onTaskDeleted', () => {
  it('closes the linked issue using the creator token', async () => {
    await handler(event({ githubIssueNumber: 7, createdBy: 'creator' }));
    expect(mockCloseIssue).toHaveBeenCalledWith('octocat', 'hello', 'ght', 7);
  });

  it('no-ops when the task had no linked issue', async () => {
    await handler(event({ createdBy: 'creator' }));
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it('no-ops when the creator has no GitHub token', async () => {
    store.set('apps/gitsync/users/creator', {});
    await handler(event({ githubIssueNumber: 7, createdBy: 'creator' }));
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it('swallows a GitHub failure (best-effort, no throw)', async () => {
    mockCloseIssue.mockRejectedValue(new Error('boom'));
    await expect(
      handler(event({ githubIssueNumber: 7, createdBy: 'creator' })),
    ).resolves.toBeUndefined();
  });

  it('duplicate delivery → no-op', async () => {
    mockMarkIdempotent.mockResolvedValue(false);
    await handler(event({ githubIssueNumber: 7, createdBy: 'creator' }));
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });
});
