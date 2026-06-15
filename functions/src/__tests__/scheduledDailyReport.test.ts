// Unit test for scheduledDailyReport — verifies it fans out one Cloud Task per
// repo to the dailyReportWorker queue, and that one failed enqueue does not
// abort the rest.

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// onSchedule returns the handler so the test can invoke it directly.
jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: (_opts: unknown, handler: () => Promise<void>) => handler,
}));

let repoIds: string[] = [];
const fakeDb = {
  collection: (path: string) => ({
    async get() {
      if (path !== 'apps/gitsync/repos') return { docs: [] };
      return { docs: repoIds.map((id) => ({ id })) };
    },
  }),
};
jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

type Task = { repoId: string; date: string };
const enqueue = jest.fn<Promise<void>, [Task]>(async () => undefined);
const taskQueue = jest.fn(() => ({ enqueue }));
jest.mock('firebase-admin/functions', () => ({
  getFunctions: () => ({ taskQueue }),
}));

import { scheduledDailyReport } from '../triggers/scheduledDailyReport';

const run = scheduledDailyReport as unknown as () => Promise<void>;

beforeEach(() => {
  repoIds = [];
  enqueue.mockReset();
  enqueue.mockResolvedValue(undefined);
  taskQueue.mockClear();
});

describe('scheduledDailyReport', () => {
  it('enqueues one task per repo targeting the dailyReportWorker queue', async () => {
    repoIds = ['repo-a', 'repo-b', 'repo-c'];
    await run();

    expect(taskQueue).toHaveBeenCalledWith(
      'locations/asia-east1/functions/dailyReportWorker',
    );
    expect(enqueue).toHaveBeenCalledTimes(3);
    const enqueuedRepos = enqueue.mock.calls.map((c) => c[0].repoId);
    expect(enqueuedRepos.sort()).toEqual(['repo-a', 'repo-b', 'repo-c']);
    // Every task carries a YYYY-MM-DD date.
    for (const call of enqueue.mock.calls) {
      expect(call[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('does nothing when there are no repos', async () => {
    repoIds = [];
    await run();
    expect(taskQueue).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('continues after one enqueue rejects', async () => {
    repoIds = ['ok-1', 'boom', 'ok-2'];
    enqueue.mockImplementation(async (data: Task) => {
      if (data.repoId === 'boom') throw new Error('quota');
    });
    await expect(run()).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(3);
  });
});
