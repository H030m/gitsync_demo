// Unit tests for the githubWebhook onRequest handler.
//
// Boundary mocks (testing-guidelines.md):
//   - firebase-functions/v2/https → onRequest returns the raw handler so we can
//     invoke it directly with fake req/res.
//   - firebase-functions/v2 → logger is a no-op.
//   - ../admin → db is a hand-rolled fake Firestore (doc/get/set/batch).
//   - ../tools/idempotency → markIdempotent is a mock (controls dup branch).
//
// A real HMAC is computed in the tests to exercise the verify path.

import { createHmac } from 'node:crypto';

// ---- Mocks ----------------------------------------------------------------

jest.mock('firebase-functions/v2/https', () => ({
  // onRequest just hands back the inner handler for direct invocation.
  onRequest: (_opts: unknown, handler: unknown) => handler,
}));

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockMarkIdempotent = jest.fn();
jest.mock('../tools/idempotency', () => ({
  markIdempotent: (...args: unknown[]) => mockMarkIdempotent(...args),
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
    async set(data: Record<string, unknown>, options?: { merge?: boolean }) {
      if (options?.merge) {
        store.set(path, { ...(store.get(path) ?? {}), ...data });
      } else {
        store.set(path, data);
      }
    },
    // Mirrors Firestore's create(): rejects with ALREADY_EXISTS (gRPC code 6)
    // when the doc already exists — drives the first-seen-wins handlePush path.
    async create(data: Record<string, unknown>) {
      if (store.has(path)) {
        const err = new Error('ALREADY_EXISTS') as Error & { code: number };
        err.code = 6;
        throw err;
      }
      store.set(path, data);
    },
  };
}

const fakeDb = {
  doc: (path: string) => makeDocRef(path),
  batch: () => {
    const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
    return {
      set(ref: { path: string }, data: Record<string, unknown>) {
        writes.push({ path: ref.path, data });
      },
      async commit() {
        for (const w of writes) store.set(w.path, w.data);
      },
    };
  },
};

jest.mock('../admin', () => ({
  db: fakeDb,
  REGION: 'asia-east1',
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__serverTimestamp__',
  },
  Timestamp: {
    fromDate: (d: Date) => ({ __ms__: d.getTime(), toMillis: () => d.getTime() }),
  },
}));

// Import after mocks are registered.
import { githubWebhook } from '../handlers/githubWebhook';

// ---- Helpers --------------------------------------------------------------

const SECRET = 'topsecret';
const OWNER = 'octocat';
const REPO = 'hello';
const REPO_ID = `${OWNER}_${REPO}`;

interface FakeRes {
  statusCode?: number;
  body?: unknown;
  status: (code: number) => FakeRes;
  send: (b?: unknown) => FakeRes;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    send(b?: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

function sign(rawBody: Buffer): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(rawBody).digest('hex');
}

interface ReqOpts {
  body: Record<string, unknown>;
  event: string;
  delivery?: string;
  signature?: string | null; // null = omit; undefined = auto-correct
}

function makeReq(opts: ReqOpts) {
  const rawBody = Buffer.from(JSON.stringify(opts.body));
  const headers: Record<string, string | undefined> = {
    'x-github-event': opts.event,
    'x-github-delivery': opts.delivery ?? 'delivery-1',
  };
  if (opts.signature === null) {
    headers['x-hub-signature-256'] = undefined;
  } else if (opts.signature === undefined) {
    headers['x-hub-signature-256'] = sign(rawBody);
  } else {
    headers['x-hub-signature-256'] = opts.signature;
  }
  return {
    body: opts.body,
    rawBody,
    header: (name: string) => headers[name.toLowerCase()],
  };
}

const handler = githubWebhook as unknown as (
  req: unknown,
  res: FakeRes,
) => Promise<void>;

function pushBody(extra?: Partial<Record<string, unknown>>) {
  return {
    ref: 'refs/heads/main',
    repository: { name: REPO, default_branch: 'main', owner: { login: OWNER } },
    commits: [
      {
        id: 'abc123',
        message: 'fix: something',
        url: 'https://github.com/octocat/hello/commit/abc123',
        timestamp: '2026-06-02T00:00:00Z',
        author: { name: 'Octo', email: 'octo@example.com', username: 'octocat' },
        added: ['a.ts'],
        removed: [],
        modified: ['b.ts'],
      },
    ],
    ...extra,
  };
}

function prBody(extra?: Partial<Record<string, unknown>>) {
  return {
    action: 'closed',
    repository: { name: REPO, owner: { login: OWNER } },
    pull_request: {
      number: 7,
      title: 'Add feature',
      body: 'closes #3',
      merged: true,
      merged_at: '2026-06-02T00:00:00Z',
      head: { ref: 'feature' },
      base: { ref: 'main' },
    },
    ...extra,
  };
}

function issueBody(extra?: Partial<Record<string, unknown>>) {
  return {
    action: 'closed',
    repository: { name: REPO, owner: { login: OWNER } },
    issue: { number: 3, state: 'closed', title: 'Bug' },
    ...extra,
  };
}

beforeEach(() => {
  store.clear();
  mockMarkIdempotent.mockReset();
  mockMarkIdempotent.mockResolvedValue(true);
  store.set(`apps/gitsync/repos/${REPO_ID}`, { webhookSecret: SECRET });
});

// ---- Tests ----------------------------------------------------------------

describe('githubWebhook', () => {
  it('valid push signature → 200 + commit doc written', async () => {
    const req = makeReq({ body: pushBody(), event: 'push' });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    const commit = store.get(`apps/gitsync/repos/${REPO_ID}/commits/abc123`);
    expect(commit).toMatchObject({
      repoId: REPO_ID,
      sha: 'abc123',
      message: 'fix: something',
      // Canonical schema: list of touched paths (added + removed + modified).
      filesChanged: ['a.ts', 'b.ts'],
      // Stored under canonical `login` (payload's `author.username` → `login`).
      author: { name: 'Octo', login: 'octocat' },
      // 06-05 D1: branch attribution from the push ref.
      branch: 'main',
    });
    // committedAt is a real Timestamp parsed from the payload's ISO string —
    // string-typed values would fall out of every Timestamp range query.
    expect((commit?.committedAt as { __ms__: number }).__ms__).toBe(
      Date.parse('2026-06-02T00:00:00Z'),
    );
  });

  it('push commit without a timestamp → committedAt falls back to server time', async () => {
    const body = pushBody();
    delete (body.commits as Array<Record<string, unknown>>)[0].timestamp;
    const req = makeReq({ body, event: 'push' });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const commit = store.get(`apps/gitsync/repos/${REPO_ID}/commits/abc123`);
    expect(commit?.committedAt).toBe('__serverTimestamp__');
  });

  it('invalid signature → 401, no write', async () => {
    const req = makeReq({
      body: pushBody(),
      event: 'push',
      signature: 'sha256=deadbeef',
    });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/commits/abc123`)).toBeUndefined();
    expect(mockMarkIdempotent).not.toHaveBeenCalled();
  });

  it('missing signature header → 401, no write', async () => {
    const req = makeReq({ body: pushBody(), event: 'push', signature: null });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/commits/abc123`)).toBeUndefined();
  });

  it('unknown repo / missing secret → 401', async () => {
    store.delete(`apps/gitsync/repos/${REPO_ID}`);
    const req = makeReq({ body: pushBody(), event: 'push' });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it('duplicate delivery (markIdempotent→false) → 200 dup, no write', async () => {
    mockMarkIdempotent.mockResolvedValue(false);
    const req = makeReq({ body: pushBody(), event: 'push' });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, dup: true });
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/commits/abc123`)).toBeUndefined();
  });

  it('push to non-default branch → 200, commit doc written with branch (06-05 D1)', async () => {
    const req = makeReq({
      body: pushBody({ ref: 'refs/heads/feature/x' }),
      event: 'push',
    });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const commit = store.get(`apps/gitsync/repos/${REPO_ID}/commits/abc123`);
    expect(commit).toMatchObject({ sha: 'abc123', branch: 'feature/x' });
    // 06-14: non-default branch must NOT set onDefaultBranch.
    expect(commit).not.toHaveProperty('onDefaultBranch');
  });

  it('push to default branch → onDefaultBranch:true marked on the commit (06-14)', async () => {
    const req = makeReq({ body: pushBody(), event: 'push' });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const commit = store.get(`apps/gitsync/repos/${REPO_ID}/commits/abc123`);
    expect(commit?.onDefaultBranch).toBe(true);
  });

  it('merge re-push to default branch marks a pre-existing (feature-branch) doc (06-14)', async () => {
    // First seen on a feature branch → no onDefaultBranch.
    await handler(
      makeReq({
        body: pushBody({ ref: 'refs/heads/feature/x' }),
        event: 'push',
        delivery: 'd-feature',
      }),
      makeRes(),
    );
    const path = `apps/gitsync/repos/${REPO_ID}/commits/abc123`;
    expect(store.get(path)).not.toHaveProperty('onDefaultBranch');
    // onCommitCreated later enriched the doc.
    store.set(path, { ...(store.get(path) ?? {}), aiSummary: 'enriched' });

    // Same sha re-pushed via merge to main: create() is ALREADY_EXISTS, but the
    // set(merge) flips onDefaultBranch without clobbering enrichment / branch.
    await handler(
      makeReq({ body: pushBody({ ref: 'refs/heads/main' }), event: 'push', delivery: 'd-main' }),
      makeRes(),
    );

    const commit = store.get(path);
    expect(commit).toMatchObject({
      branch: 'feature/x',
      aiSummary: 'enriched',
      onDefaultBranch: true,
    });
  });

  it('re-push of an existing sha (merge to main) does NOT overwrite the first doc', async () => {
    // First seen on a feature branch.
    await handler(
      makeReq({
        body: pushBody({ ref: 'refs/heads/feature/x' }),
        event: 'push',
        delivery: 'delivery-1',
      }),
      makeRes(),
    );
    // onCommitCreated later enriched the doc.
    const path = `apps/gitsync/repos/${REPO_ID}/commits/abc123`;
    store.set(path, { ...(store.get(path) ?? {}), aiSummary: 'enriched', workSummary: 'cached' });

    // Same sha re-pushed via merge to main (new delivery id).
    await handler(
      makeReq({
        body: pushBody({ ref: 'refs/heads/main' }),
        event: 'push',
        delivery: 'delivery-2',
      }),
      makeRes(),
    );

    const commit = store.get(path);
    // First-seen branch + enrichment preserved; not clobbered by the re-push.
    expect(commit).toMatchObject({
      branch: 'feature/x',
      aiSummary: 'enriched',
      workSummary: 'cached',
    });
  });

  it('PR merged → pullRequests doc written', async () => {
    const req = makeReq({ body: prBody(), event: 'pull_request' });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const pr = store.get(`apps/gitsync/repos/${REPO_ID}/pullRequests/7`);
    expect(pr).toMatchObject({
      repoId: REPO_ID,
      number: 7,
      title: 'Add feature',
      body: 'closes #3',
      state: 'merged',
      headBranch: 'feature',
      baseBranch: 'main',
      commitShas: [],
    });
  });

  it('PR closed but not merged → no write', async () => {
    const body = prBody();
    (body.pull_request as Record<string, unknown>).merged = false;
    const req = makeReq({ body, event: 'pull_request' });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/pullRequests/7`)).toBeUndefined();
  });

  it('issue event → issues doc upserted', async () => {
    const req = makeReq({ body: issueBody(), event: 'issues' });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const issue = store.get(`apps/gitsync/repos/${REPO_ID}/issues/3`);
    expect(issue).toMatchObject({
      repoId: REPO_ID,
      number: 3,
      state: 'closed',
      title: 'Bug',
      action: 'closed',
    });
  });

  it('unknown event → 200, no write', async () => {
    const req = makeReq({
      body: { repository: { name: REPO, owner: { login: OWNER } } },
      event: 'star',
    });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  // ---- PR opened / ready_for_review (triage agent) ------------------------

  function prOpenedBody(extra?: Partial<Record<string, unknown>>) {
    return {
      action: 'opened',
      repository: { name: REPO, owner: { login: OWNER } },
      pull_request: {
        number: 9,
        title: 'Add login UI',
        body: 'Hooks up the login flow.',
        draft: false,
        html_url: 'https://github.com/octocat/hello/pull/9',
        created_at: '2026-06-08T00:00:00Z',
        user: { login: 'alice' },
        head: { ref: 'feature/login', sha: 'sha-head' },
        base: { ref: 'develop' },
      },
      ...extra,
    };
  }

  it('PR opened (non-draft) → state=open pullRequests doc with author + head sha', async () => {
    const req = makeReq({ body: prOpenedBody(), event: 'pull_request' });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const pr = store.get(`apps/gitsync/repos/${REPO_ID}/pullRequests/9`);
    expect(pr).toMatchObject({
      repoId: REPO_ID,
      number: 9,
      state: 'open',
      title: 'Add login UI',
      authorLogin: 'alice',
      headBranch: 'feature/login',
      headSha: 'sha-head',
      baseBranch: 'develop',
      htmlUrl: 'https://github.com/octocat/hello/pull/9',
      openedAt: '2026-06-08T00:00:00Z',
    });
    expect(pr).not.toHaveProperty('triagedAt');
  });

  it('PR opened as draft → no write (avoid noise; ready_for_review will re-fire)', async () => {
    const body = prOpenedBody();
    (body.pull_request as Record<string, unknown>).draft = true;
    const req = makeReq({ body, event: 'pull_request' });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(store.get(`apps/gitsync/repos/${REPO_ID}/pullRequests/9`)).toBeUndefined();
  });

  it('PR ready_for_review (draft → ready) → state=open doc written', async () => {
    const body = prOpenedBody({ action: 'ready_for_review' });
    const req = makeReq({ body, event: 'pull_request' });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const pr = store.get(`apps/gitsync/repos/${REPO_ID}/pullRequests/9`);
    expect(pr).toMatchObject({ state: 'open', authorLogin: 'alice' });
  });

  it('PR reopened / synchronize → no write (we do not re-triage)', async () => {
    for (const action of ['reopened', 'synchronize']) {
      const body = prOpenedBody({ action });
      const req = makeReq({
        body,
        event: 'pull_request',
        delivery: `d-${action}`,
      });
      const res = makeRes();
      await handler(req, res);
      expect(res.statusCode).toBe(200);
      expect(store.get(`apps/gitsync/repos/${REPO_ID}/pullRequests/9`)).toBeUndefined();
    }
  });

  it('PR opened then merged → triagedAt + open metadata preserved alongside merge fields', async () => {
    // Open it.
    await handler(
      makeReq({ body: prOpenedBody(), event: 'pull_request', delivery: 'd-open' }),
      makeRes(),
    );
    // Simulate the trigger having written triage results.
    const path = `apps/gitsync/repos/${REPO_ID}/pullRequests/9`;
    store.set(path, {
      ...(store.get(path) ?? {}),
      aiSummary: 'Adds login.',
      triagedAt: '__earlier__',
    });
    // Now the same PR merges. handlePR uses merge:true so triage fields survive.
    const merged = {
      action: 'closed',
      repository: { name: REPO, owner: { login: OWNER } },
      pull_request: {
        number: 9,
        title: 'Add login UI',
        body: 'closes #3',
        merged: true,
        merged_at: '2026-06-08T01:00:00Z',
        head: { ref: 'feature/login' },
        base: { ref: 'develop' },
      },
    };
    await handler(
      makeReq({ body: merged, event: 'pull_request', delivery: 'd-merge' }),
      makeRes(),
    );

    const pr = store.get(path);
    expect(pr).toMatchObject({
      state: 'merged',
      mergedAt: '2026-06-08T01:00:00Z',
      // Triage fields from earlier are preserved by the merge:true write.
      aiSummary: 'Adds login.',
      triagedAt: '__earlier__',
    });
  });
});
