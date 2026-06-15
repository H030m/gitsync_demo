// Unit tests for the backfillEmbeddings callable (W2d).
//
// Boundary mocks:
//   - firebase-functions/v2/https → onCall returns raw handler; HttpsError code.
//   - firebase-functions/v2 → logger no-op.
//   - ../admin → fake Firestore (collection/orderBy('__name__')/limit/startAfter
//     + per-doc ref.update).
//   - ../tools/embedding → embedToFieldValue stubbed.
//   - ../config → openaiKey value stub.

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

jest.mock('../config', () => ({ openaiKey: { value: () => 'k' } }));

const mockEmbed = jest.fn();
jest.mock('../tools/embedding', () => ({
  embedToFieldValue: (...args: unknown[]) => mockEmbed(...args),
}));

// ---- Fake Firestore -------------------------------------------------------

const store = new Map<string, Record<string, unknown>>();

function childIdsOf(colPath: string): string[] {
  return [...store.keys()]
    .filter(
      (p) =>
        p.startsWith(`${colPath}/`) &&
        p.slice(colPath.length + 1).indexOf('/') === -1,
    )
    .map((p) => p.split('/').pop() as string)
    .sort(); // __name__ order
}

function makeQuery(colPath: string, after: string | undefined, cap: number) {
  return {
    orderBy(_field: string) {
      return makeQuery(colPath, after, cap);
    },
    limit(n: number) {
      return makeQuery(colPath, after, n);
    },
    startAfter(id: string) {
      return makeQuery(colPath, id, cap);
    },
    async get() {
      let ids = childIdsOf(colPath);
      if (after) ids = ids.filter((id) => id > after);
      ids = ids.slice(0, cap);
      return {
        empty: ids.length === 0,
        size: ids.length,
        docs: ids.map((id) => {
          const path = `${colPath}/${id}`;
          return {
            id,
            data: () => store.get(path),
            ref: {
              path,
              async update(patch: Record<string, unknown>) {
                store.set(path, { ...(store.get(path) ?? {}), ...patch });
              },
            },
          };
        }),
      };
    },
  };
}

const fakeDb = {
  collection: (path: string) => makeQuery(path, undefined, Infinity),
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

import { backfillEmbeddings } from '../handlers/backfillEmbeddings';

const handler = backfillEmbeddings as unknown as (req: {
  auth: unknown;
  data: unknown;
}) => Promise<{
  done: boolean;
  nextCursor?: string;
  stats: {
    scanned: number;
    embedded: number;
    skippedExisting: number;
    skippedFiltered: number;
    failed: number;
  };
}>;

const REPO = 'octocat_hello';
const AUTH = { uid: 'u1' };

beforeEach(() => {
  store.clear();
  mockEmbed.mockReset().mockResolvedValue({ __vector__: [0.1] });
});

describe('backfillEmbeddings validation', () => {
  it('rejects unauthenticated callers (failed-precondition)', async () => {
    await expect(
      handler({ auth: null, data: { repoId: REPO, collection: 'commits' } }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects a missing repoId (invalid-argument)', async () => {
    await expect(
      handler({ auth: AUTH, data: { collection: 'commits' } }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects an unknown collection (invalid-argument)', async () => {
    await expect(
      handler({ auth: AUTH, data: { repoId: REPO, collection: 'pullRequests' } }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('backfillEmbeddings commits', () => {
  const col = `apps/gitsync/repos/${REPO}/commits`;

  it('embeds eligible docs and reports correct stats', async () => {
    store.set(`${col}/a`, { message: 'implement the new feature properly' });
    store.set(`${col}/b`, { message: 'Merge branch main' }); // noise → skip
    store.set(`${col}/c`, {
      message: 'already done',
      messageEmbedding: { __vector__: [9] },
    }); // existing → skip

    const res = await handler({
      auth: AUTH,
      data: { repoId: REPO, collection: 'commits' },
    });

    expect(res.done).toBe(true);
    expect(res.stats).toEqual({
      scanned: 3,
      embedded: 1,
      skippedExisting: 1,
      skippedFiltered: 1,
      failed: 0,
    });
    expect(store.get(`${col}/a`)?.messageEmbedding).toEqual({ __vector__: [0.1] });
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it('counts a per-doc embed failure without aborting the batch', async () => {
    store.set(`${col}/a`, { message: 'first substantive commit message' });
    store.set(`${col}/b`, { message: 'second substantive commit message' });
    mockEmbed
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ __vector__: [0.2] });

    const res = await handler({
      auth: AUTH,
      data: { repoId: REPO, collection: 'commits' },
    });

    expect(res.stats.scanned).toBe(2);
    expect(res.stats.failed).toBe(1);
    expect(res.stats.embedded).toBe(1);
    expect(res.done).toBe(true);
  });
});

describe('backfillEmbeddings discordMessages', () => {
  const col = `apps/gitsync/repos/${REPO}/discordMessages`;

  it('uses the embedding field + shouldKeepMessage filter', async () => {
    store.set(`${col}/m1`, { content: 'a genuinely useful discussion point' });
    store.set(`${col}/m2`, { content: 'lol' }); // noise → skip

    const res = await handler({
      auth: AUTH,
      data: { repoId: REPO, collection: 'discordMessages' },
    });

    expect(res.stats.embedded).toBe(1);
    expect(res.stats.skippedFiltered).toBe(1);
    expect(store.get(`${col}/m1`)?.embedding).toEqual({ __vector__: [0.1] });
  });
});

describe('backfillEmbeddings cursor resume', () => {
  const col = `apps/gitsync/repos/${REPO}/commits`;

  it('resumes from a cursor and skips already-scanned docs', async () => {
    // Two docs; pass a cursor past the first so only the second is scanned.
    store.set(`${col}/aaa`, { message: 'first substantive commit message' });
    store.set(`${col}/bbb`, { message: 'second substantive commit message' });

    const res = await handler({
      auth: AUTH,
      data: { repoId: REPO, collection: 'commits', cursor: 'aaa' },
    });

    expect(res.stats.scanned).toBe(1);
    expect(res.stats.embedded).toBe(1);
    expect(store.get(`${col}/bbb`)?.messageEmbedding).toEqual({ __vector__: [0.1] });
    // First doc was never touched.
    expect(store.get(`${col}/aaa`)?.messageEmbedding).toBeUndefined();
  });
});
