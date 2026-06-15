// Unit tests for discordDailyDigestFlow.
//
// Boundaries mocked:
//   - firebase-functions/v2 → logger no-op
//   - ../admin → fake Firestore exposing a chainable query (where/orderBy/get)
//     and doc().set() so we can assert the digest write
//   - ../config → getOpenAI returns a stub whose completion is configurable
//   - firebase-admin/firestore → FieldValue.serverTimestamp + a Timestamp whose
//     fromMillis records the millis (so we can assert the day-boundary filter)

// ---- Mocks ----------------------------------------------------------------

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Records the where() clauses applied to the discordMessages query, and serves
// whatever docs the test seeds.
interface QueryState {
  wheres: Array<{ field: string; op: string; value: unknown }>;
}

let seededDocs: Array<Record<string, unknown>> = [];
let lastQuery: QueryState | null = null;
// The existing digest doc the flow reads before writing (lock check).
let existingDigest: Record<string, unknown> | undefined;
const setSpy = jest.fn();

function makeQuery(state: QueryState): Record<string, unknown> {
  return {
    where(field: string, op: string, value: unknown) {
      state.wheres.push({ field, op, value });
      return makeQuery(state);
    },
    orderBy() {
      return makeQuery(state);
    },
    async get() {
      const docs = seededDocs.map((data) => ({ data: () => data }));
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  };
}

const fakeDb = {
  collection: () => {
    lastQuery = { wheres: [] };
    return makeQuery(lastQuery);
  },
  doc: () => ({
    // The flow reads the existing digest to honor a lock before writing.
    // Default: no existing doc (unlocked) → the write proceeds.
    get: async () => ({
      exists: existingDigest !== undefined,
      data: () => existingDigest,
    }),
    set: (data: Record<string, unknown>) => setSpy(data),
  }),
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

const mockCreate = jest.fn();
jest.mock('../config', () => ({
  getOpenAI: () => ({ chat: { completions: { create: mockCreate } } }),
  MODELS: { reasoning: 'gpt-4o', fast: 'gpt-4o-mini', embedding: 'text-embedding-3-small' },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__serverTimestamp__' },
  Timestamp: {
    // Record the raw millis so tests can assert the Taipei day boundaries.
    fromMillis: (ms: number) => ({ __ms: ms }),
  },
}));

import { discordDailyDigestFlow } from '../flows/discordDailyDigest';

beforeEach(() => {
  seededDocs = [];
  lastQuery = null;
  existingDigest = undefined;
  setSpy.mockReset();
  mockCreate.mockReset();
});

describe('discordDailyDigestFlow', () => {
  it('early-returns without calling OpenAI when the day has no messages', async () => {
    const res = await discordDailyDigestFlow({ repoId: 'o_r', date: '2026-06-02' });

    expect(res).toEqual({ date: '2026-06-02', messageCount: 0, markdown: null });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('filters by Asia/Taipei day boundaries (UTC+8)', async () => {
    await discordDailyDigestFlow({ repoId: 'o_r', date: '2026-06-02' });

    // 2026-06-02 00:00 Taipei == 2026-06-01 16:00 UTC.
    const startUtc = Date.UTC(2026, 5, 1, 16, 0, 0);
    const endUtc = startUtc + 24 * 60 * 60 * 1000;

    const gte = lastQuery?.wheres.find((w) => w.op === '>=');
    const lt = lastQuery?.wheres.find((w) => w.op === '<');
    expect(gte?.field).toBe('timestamp');
    expect((gte?.value as { __ms: number }).__ms).toBe(startUtc);
    expect((lt?.value as { __ms: number }).__ms).toBe(endUtc);
  });

  it('summarizes and writes a digest doc when messages exist', async () => {
    seededDocs = [
      { authorName: 'Kai', content: 'shipped the board' },
      { authorName: 'Jun', content: 'blocked on auth' },
    ];
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '- Kai shipped the board\n- Jun blocked on auth' } }],
    });

    const res = await discordDailyDigestFlow({ repoId: 'o_r', date: '2026-06-02' });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ model: 'gpt-4o-mini' });
    expect(res.messageCount).toBe(2);
    expect(res.markdown).toContain('Kai shipped the board');

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0][0]).toMatchObject({
      date: '2026-06-02',
      messageCount: 2,
      markdown: '- Kai shipped the board\n- Jun blocked on auth',
    });
  });

  it('does not overwrite a locked digest (keeps the pinned markdown)', async () => {
    seededDocs = [{ authorName: 'Kai', content: 'shipped the board' }];
    existingDigest = { markdown: '# pinned', locked: true };
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '- regenerated' } }],
    });

    const res = await discordDailyDigestFlow({ repoId: 'o_r', date: '2026-06-02' });

    expect(setSpy).not.toHaveBeenCalled();
    expect(res.markdown).toBe('# pinned');
    expect(res.messageCount).toBe(1);
  });

  it('throws on a malformed date', async () => {
    await expect(
      discordDailyDigestFlow({ repoId: 'o_r', date: '06/02/2026' }),
    ).rejects.toThrow(/invalid date/);
  });
});
