// Unit tests for setRepoChannel (onRequest, secret-auth). Verifies the
// parseGithubUrl reuse (URL → repoId), secret/validation guards, the 404 on a
// missing repo, and the arrayUnion write.
//
// Boundaries mocked:
//   - firebase-functions/v2/https → onRequest returns the raw handler
//   - firebase-functions/v2 → logger no-op
//   - ../admin → fake Firestore (doc/get/update)
//   - ../config → discordIngestSecret with a fixed value
//   - firebase-admin/firestore → FieldValue.arrayUnion records its arg

jest.mock('firebase-functions/v2/https', () => ({
  onRequest: (_opts: unknown, handler: unknown) => handler,
}));

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const store = new Map<string, Record<string, unknown>>();
const updateSpy = jest.fn();
const setSpy = jest.fn();

function makeDocRef(path: string) {
  return {
    path,
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    async update(data: Record<string, unknown>) {
      updateSpy(path, data);
      store.set(path, { ...(store.get(path) ?? {}), ...data });
    },
    collection(name: string) {
      return {
        doc(id: string) {
          const subPath = `${path}/${name}/${id}`;
          return {
            async set(data: Record<string, unknown>) {
              setSpy(subPath, data);
              store.set(subPath, { ...(store.get(subPath) ?? {}), ...data });
            },
          };
        },
      };
    },
  };
}

jest.mock('../admin', () => ({
  db: { doc: (path: string) => makeDocRef(path) },
  REGION: 'asia-east1',
}));

jest.mock('../config', () => ({
  discordIngestSecret: { value: () => 'secret123' },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
    serverTimestamp: () => ({ __serverTimestamp: true }),
  },
}));

import { setRepoChannel } from '../handlers/setRepoChannel';

const handler = setRepoChannel as unknown as (
  req: { header: (k: string) => string | undefined; method: string; body: unknown },
  res: FakeRes,
) => Promise<void>;

interface FakeRes {
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  send(b: unknown): void;
}

function makeRes(): FakeRes {
  return {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(b: unknown) {
      this.body = b;
    },
  };
}

function makeReq(opts: {
  secret?: string;
  method?: string;
  body?: unknown;
}): { header: (k: string) => string | undefined; method: string; body: unknown } {
  return {
    header: (k: string) =>
      k === 'x-ingest-secret' ? opts.secret ?? 'secret123' : undefined,
    method: opts.method ?? 'POST',
    body: opts.body,
  };
}

beforeEach(() => {
  store.clear();
  updateSpy.mockReset();
  setSpy.mockReset();
});

describe('setRepoChannel', () => {
  it('rejects a bad secret with 401', async () => {
    const res = makeRes();
    await handler(makeReq({ secret: 'wrong', body: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-POST with 405', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET', body: {} }), res);
    expect(res.statusCode).toBe(405);
  });

  it('rejects an unparseable githubUrl with 400', async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { githubUrl: 'not a url', guildId: 'g1', channelId: 'c1' } }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the repo doc is missing', async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          githubUrl: 'https://github.com/H030m/gitsync.git',
          guildId: 'g1',
          channelId: 'c1',
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(404);
  });

  it('arrayUnions the channel and sets the guild on success', async () => {
    store.set('apps/gitsync/repos/H030m_gitsync', { name: 'H030m/gitsync' });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          githubUrl: 'https://github.com/H030m/gitsync.git',
          guildId: 'g1',
          channelId: 'c1',
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ repoId: 'H030m_gitsync' });
    expect(updateSpy).toHaveBeenCalledWith('apps/gitsync/repos/H030m_gitsync', {
      discordChannelIds: { __arrayUnion: 'c1' },
      discordGuildId: 'g1',
    });
    // Also seeds the per-channel config doc (holds startDate + watermark later).
    expect(setSpy).toHaveBeenCalledWith(
      'apps/gitsync/repos/H030m_gitsync/discordChannels/c1',
      expect.objectContaining({ guildId: 'g1' }),
    );
  });
});
