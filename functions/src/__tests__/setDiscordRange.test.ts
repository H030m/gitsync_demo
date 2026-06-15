// Unit tests for setDiscordRange (onCall, auth). After the 06-05 data-loss
// incident this callable is ADDITIVE-ONLY: it persists the range + resets each
// channel watermark, but NEVER deletes discordMessages / discordDigests.
//
// The headline regression test asserts that out-of-window message and digest
// docs SURVIVE a range change (the bug was that they were pruned).
//
// Boundaries mocked:
//   - firebase-functions/v2/https → onCall returns the raw handler; HttpsError
//   - firebase-functions/v2 → logger no-op
//   - ../admin → fake Firestore (doc/get/set, collection/get, batch)
//   - firebase-admin/firestore → FieldValue sentinels

class FakeHttpsError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'HttpsError';
  }
}

jest.mock('firebase-functions/v2/https', () => ({
  onCall: (_opts: unknown, handler: unknown) => handler,
  HttpsError: FakeHttpsError,
}));

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const store = new Map<string, Record<string, unknown>>();
const deleteSpy = jest.fn();

function childDocsOf(colPath: string): Array<[string, Record<string, unknown>]> {
  return [...store.entries()].filter(
    ([p]) =>
      p.startsWith(`${colPath}/`) &&
      p.slice(colPath.length + 1).indexOf('/') === -1,
  );
}

function makeCollection(colPath: string) {
  return {
    doc(id: string) {
      return makeDocRef(`${colPath}/${id}`);
    },
    async get() {
      const docs = childDocsOf(colPath);
      return {
        empty: docs.length === 0,
        size: docs.length,
        docs: docs.map(([p, d]) => ({
          id: p.split('/').pop() as string,
          ref: makeDocRef(p),
          data: () => d,
        })),
      };
    },
  };
}

function makeDocRef(path: string) {
  return {
    path,
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    async set(data: Record<string, unknown>) {
      store.set(path, { ...(store.get(path) ?? {}), ...data });
    },
    collection(name: string) {
      return makeCollection(`${path}/${name}`);
    },
  };
}

const fakeDb = {
  doc: (path: string) => makeDocRef(path),
  batch() {
    const ops: Array<() => void> = [];
    return {
      set(ref: { path: string }, data: Record<string, unknown>) {
        ops.push(() => store.set(ref.path, { ...(store.get(ref.path) ?? {}), ...data }));
      },
      delete(ref: { path: string }) {
        ops.push(() => {
          deleteSpy(ref.path);
          store.delete(ref.path);
        });
      },
      async commit() {
        for (const op of ops) op();
      },
    };
  },
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__ts__',
    delete: () => '__delete__',
  },
}));

import { setDiscordRange } from '../handlers/setDiscordRange';

const handler = setDiscordRange as unknown as (req: {
  auth: { uid: string } | null;
  data: Record<string, unknown>;
}) => Promise<{ ok: boolean; channelCount: number }>;

const REPO = 'team17_gitsync';
const repoPath = `apps/gitsync/repos/${REPO}`;

beforeEach(() => {
  store.clear();
  deleteSpy.mockReset();
});

describe('setDiscordRange (additive-only)', () => {
  it('rejects an unauthenticated call', async () => {
    await expect(
      handler({ auth: null, data: { repoId: REPO, startDate: '2026-06-01', endDate: '2026-06-05' } }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects a missing repoId', async () => {
    await expect(
      handler({ auth: { uid: 'u1' }, data: { startDate: '2026-06-01', endDate: '2026-06-05' } }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a malformed date', async () => {
    await expect(
      handler({ auth: { uid: 'u1' }, data: { repoId: REPO, startDate: 'nope', endDate: '2026-06-05' } }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a reversed range', async () => {
    await expect(
      handler({ auth: { uid: 'u1' }, data: { repoId: REPO, startDate: '2026-06-05', endDate: '2026-06-01' } }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('returns not-found for a missing repo', async () => {
    await expect(
      handler({ auth: { uid: 'u1' }, data: { repoId: REPO, startDate: '2026-06-01', endDate: '2026-06-05' } }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('persists the range and resets channel watermarks', async () => {
    store.set(repoPath, { name: 'team17/gitsync', discordChannelIds: ['c1'] });
    store.set(`${repoPath}/discordChannels/c1`, { startDate: '2026-05-01', lastMessageId: '999' });

    const res = await handler({
      auth: { uid: 'u1' },
      data: { repoId: REPO, startDate: '2026-06-01', endDate: '2026-06-05' },
    });

    expect(res).toEqual({ ok: true, channelCount: 1 });
    expect(store.get(repoPath)).toMatchObject({
      discordStartDate: '2026-06-01',
      discordEndDate: '2026-06-05',
    });
    // Watermark reset: startDate updated, lastMessageId cleared (FieldValue.delete sentinel).
    expect(store.get(`${repoPath}/discordChannels/c1`)).toMatchObject({
      startDate: '2026-06-01',
      lastMessageId: '__delete__',
    });
  });

  // ---- The incident regression: NOTHING is deleted. ----
  it('does NOT delete out-of-window messages or digests', async () => {
    store.set(repoPath, { name: 'team17/gitsync', discordChannelIds: ['c1'] });
    store.set(`${repoPath}/discordChannels/c1`, { startDate: '2026-01-01' });

    // Messages + digests spanning well outside the new [06-01, 06-05] window.
    store.set(`${repoPath}/discordMessages/m-old`, { channelId: 'c1', content: 'ancient' });
    store.set(`${repoPath}/discordMessages/m-new`, { channelId: 'c1', content: 'future' });
    store.set(`${repoPath}/discordDigests/2026-01-01`, { date: '2026-01-01', markdown: 'old digest' });
    store.set(`${repoPath}/discordDigests/2026-12-31`, { date: '2026-12-31', markdown: 'new digest' });

    await handler({
      auth: { uid: 'u1' },
      data: { repoId: REPO, startDate: '2026-06-01', endDate: '2026-06-05' },
    });

    // No batch delete ever fired, and every out-of-window doc still exists.
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(store.has(`${repoPath}/discordMessages/m-old`)).toBe(true);
    expect(store.has(`${repoPath}/discordMessages/m-new`)).toBe(true);
    expect(store.has(`${repoPath}/discordDigests/2026-01-01`)).toBe(true);
    expect(store.has(`${repoPath}/discordDigests/2026-12-31`)).toBe(true);
  });
});
