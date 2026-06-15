// Unit tests for the agent-trace side-channel helpers (tools/agentTrace.ts).
//
// Boundary-mock style: a fake Firestore doc ref that records set()/update()
// calls (and can be told to throw), FieldValue stubs, and a no-op logger. We
// assert the written shapes, the best-effort error swallowing (NEVER throws),
// and the no-op behavior on a missing/invalid runId.

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__ts__',
    arrayUnion: (...items: unknown[]) => ({ __arrayUnion__: items }),
  },
}));

const setSpy = jest.fn();
const updateSpy = jest.fn();
let setThrows = false;
let updateThrows = false;
let lastPath = '';

const fakeDb = {
  doc: (path: string) => {
    lastPath = path;
    return {
      path,
      async set(data: Record<string, unknown>) {
        if (setThrows) throw new Error('boom-set');
        setSpy(path, data);
      },
      async update(patch: Record<string, unknown>) {
        if (updateThrows) throw new Error('boom-update');
        updateSpy(path, patch);
      },
    };
  },
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

import { startRun, appendStep, finishRun, TRACE_LABELS } from '../tools/agentTrace';

const REPO = 'team17_gitsync';
const RUN = 'run-abc_123';

beforeEach(() => {
  setSpy.mockClear();
  updateSpy.mockClear();
  setThrows = false;
  updateThrows = false;
  lastPath = '';
});

describe('agentTrace', () => {
  it('startRun writes {flow,status:running,steps:[],createdAt,updatedAt}', async () => {
    await startRun(REPO, RUN, 'askRepo');
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(lastPath).toBe(`apps/gitsync/repos/${REPO}/agentRuns/${RUN}`);
    const [, data] = setSpy.mock.calls[0];
    expect(data).toEqual({
      flow: 'askRepo',
      status: 'running',
      steps: [],
      createdAt: '__ts__',
      updatedAt: '__ts__',
    });
  });

  it('appendStep arrayUnions {label,at} step(s) and bumps updatedAt', async () => {
    await appendStep(REPO, RUN, TRACE_LABELS.listDayCommits);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const [, patch] = updateSpy.mock.calls[0];
    expect(patch.updatedAt).toBe('__ts__');
    const union = (patch.steps as { __arrayUnion__: Array<{ label: string; at: string }> })
      .__arrayUnion__;
    expect(union).toHaveLength(1);
    expect(union[0].label).toBe(TRACE_LABELS.listDayCommits);
    expect(typeof union[0].at).toBe('string');
  });

  it('appendStep merges multiple labels into ONE write (one round = one write)', async () => {
    await appendStep(REPO, RUN, [
      TRACE_LABELS.listDayCommits,
      TRACE_LABELS.searchDiscordMessages,
    ]);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const union = (updateSpy.mock.calls[0][1].steps as { __arrayUnion__: unknown[] })
      .__arrayUnion__;
    expect(union).toHaveLength(2);
  });

  it('appendStep drops empty labels and no-ops when nothing is left', async () => {
    await appendStep(REPO, RUN, ['', '']);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('finishRun updates status + updatedAt', async () => {
    await finishRun(REPO, RUN, 'done');
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][1]).toEqual({ status: 'done', updatedAt: '__ts__' });
  });

  it('swallows a write failure and NEVER throws (best-effort)', async () => {
    setThrows = true;
    updateThrows = true;
    await expect(startRun(REPO, RUN, 'askRepo')).resolves.toBeUndefined();
    await expect(appendStep(REPO, RUN, 'x')).resolves.toBeUndefined();
    await expect(finishRun(REPO, RUN, 'error')).resolves.toBeUndefined();
  });

  it('is a no-op for a missing runId (no Firestore touch)', async () => {
    await startRun(REPO, undefined, 'askRepo');
    await appendStep(REPO, undefined, 'x');
    await finishRun(REPO, undefined, 'done');
    expect(setSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('is a no-op for an invalid runId (path-injection guard)', async () => {
    for (const bad of ['', 'a/b', '../escape', 'has space', 'x'.repeat(201)]) {
      await startRun(REPO, bad, 'askRepo');
      await appendStep(REPO, bad, 'x');
      await finishRun(REPO, bad, 'done');
    }
    expect(setSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
