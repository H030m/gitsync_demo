// Unit tests for onPullRequestOpened (triage flow + Firestore persist + Discord post).
//
// Boundary mocks:
//   - firebase-functions/v2/firestore → onDocumentWritten returns raw handler.
//   - firebase-functions/v2 → logger no-op.
//   - firebase-admin/firestore → FieldValue.serverTimestamp sentinel.
//   - ../admin → fake Firestore (doc/get/set).
//   - ../config → openaiKey stub (trigger only references it for `secrets:`).
//   - ../tools/idempotency → markIdempotent mocked.
//   - ../tools/discordNotify → notifyDiscord mocked.
//   - ../flows/triagePr → triagePr mocked.

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (_opts: unknown, handler: unknown) => handler,
}));

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
}));

const mockMarkIdempotent = jest.fn();
jest.mock('../tools/idempotency', () => ({
  markIdempotent: (...args: unknown[]) => mockMarkIdempotent(...args),
}));

const mockNotifyDiscord = jest.fn();
jest.mock('../tools/discordNotify', () => ({
  notifyDiscord: (...args: unknown[]) => mockNotifyDiscord(...args),
}));

const mockTriagePr = jest.fn();
jest.mock('../flows/triagePr', () => ({
  triagePr: (...args: unknown[]) => mockTriagePr(...args),
}));

jest.mock('../config', () => ({ openaiKey: { name: 'OPENAI_API_KEY' } }));

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
  };
}

const fakeDb = { doc: (path: string) => makeDocRef(path) };

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

import { onPullRequestOpened } from '../triggers/onPullRequestOpened';

const REPO_ID = 'octocat_hello';
const PR_NUMBER = 42;
const handler = onPullRequestOpened as unknown as (event: unknown) => Promise<void>;

function seedRepo(extra: Record<string, unknown> = {}) {
  store.set(`apps/gitsync/repos/${REPO_ID}`, {
    name: 'octocat/hello',
    createdBy: 'uOwner',
    discordWebhookUrl: 'https://discord.test/webhook',
    ...extra,
  });
}
function seedOwnerUser(token: string | null = 'gh-token') {
  // Explicit null branch — JS default params don't fire on null (they do on
  // undefined), so callers can pass null to seed a user without a token.
  store.set(`apps/gitsync/users/uOwner`, {
    githubAccessToken: token ?? undefined,
  });
}
function seedPr(data: Record<string, unknown>) {
  store.set(
    `apps/gitsync/repos/${REPO_ID}/pullRequests/${PR_NUMBER}`,
    data,
  );
}

function makeEvent(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  id = 'evt-1',
) {
  return {
    id,
    params: { repoId: REPO_ID, prNumber: String(PR_NUMBER) },
    data: {
      before: { data: () => before },
      after: { data: () => after },
    },
  };
}

beforeEach(() => {
  store.clear();
  mockMarkIdempotent.mockReset().mockResolvedValue(true);
  mockNotifyDiscord.mockReset().mockResolvedValue(undefined);
  mockTriagePr.mockReset().mockResolvedValue({
    summary: 'Adds login UI.',
    recommendedReviewers: [
      { userId: 'uB', githubLogin: 'bob', discordUserId: '111' },
      { userId: 'uC', githubLogin: 'carol', discordUserId: '222' },
    ],
    reviewerScores: [
      { userId: 'uB', rawScore: 2, load: 0, loadPenalty: 1, finalScore: 2, slot: 1 },
      { userId: 'uC', rawScore: 1, load: 0, loadPenalty: 1, finalScore: 1, slot: 2 },
    ],
    riskTags: ['touches-functions'],
  });
});

describe('onPullRequestOpened', () => {
  it('happy path: runs triage, persists fields, posts Discord', async () => {
    seedRepo();
    seedOwnerUser();
    const prData = {
      state: 'open',
      title: 'Add login',
      body: 'desc',
      authorLogin: 'alice',
      htmlUrl: 'https://github.com/octocat/hello/pull/42',
    };
    seedPr(prData);

    await handler(makeEvent(undefined, prData));

    expect(mockTriagePr).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: REPO_ID,
        prNumber: 42,
        prAuthorLogin: 'alice',
        owner: 'octocat',
        repo: 'hello',
        accessToken: 'gh-token',
      }),
    );
    const written = store.get(
      `apps/gitsync/repos/${REPO_ID}/pullRequests/${PR_NUMBER}`,
    );
    expect(written).toMatchObject({
      aiSummary: 'Adds login UI.',
      recommendedReviewers: ['uB', 'uC'],
      recommendedReviewerScores: [
        { userId: 'uB', rawScore: 2, load: 0, loadPenalty: 1, finalScore: 2, slot: 1 },
        { userId: 'uC', rawScore: 1, load: 0, loadPenalty: 1, finalScore: 1, slot: 2 },
      ],
      riskTags: ['touches-functions'],
      triagedAt: '__ts__',
    });
    expect(mockNotifyDiscord).toHaveBeenCalledTimes(1);
    const [, content] = mockNotifyDiscord.mock.calls[0] as [string, string];
    expect(content).toContain('#42');
    expect(content).toContain('Add login');
    expect(content).toContain('<@111>');
    expect(content).toContain('<@222>');
    expect(content).toContain('touches-functions');
  });

  it('falls back to @githubLogin when reviewer has no discordUserId', async () => {
    seedRepo();
    seedOwnerUser();
    mockTriagePr.mockResolvedValue({
      summary: 's',
      recommendedReviewers: [
        { userId: 'uB', githubLogin: 'bob', discordUserId: null },
      ],
      reviewerScores: [
        { userId: 'uB', rawScore: 1, load: 0, loadPenalty: 1, finalScore: 1, slot: 1 },
      ],
      riskTags: [],
    });
    const prData = { state: 'open', title: 't', body: '', authorLogin: 'alice' };
    seedPr(prData);

    await handler(makeEvent(undefined, prData));

    const [, content] = mockNotifyDiscord.mock.calls[0] as [string, string];
    expect(content).toContain('@bob');
    expect(content).not.toContain('<@');
  });

  it('skips when state is not open (e.g. merged)', async () => {
    seedRepo();
    seedOwnerUser();
    const merged = { state: 'merged', title: 't' };
    seedPr(merged);
    await handler(makeEvent(undefined, merged));
    expect(mockTriagePr).not.toHaveBeenCalled();
    expect(mockNotifyDiscord).not.toHaveBeenCalled();
  });

  it('skips when already triaged (triagedAt set on after)', async () => {
    seedRepo();
    seedOwnerUser();
    const after = { state: 'open', triagedAt: '__earlier__' };
    seedPr(after);
    await handler(makeEvent(undefined, after));
    expect(mockTriagePr).not.toHaveBeenCalled();
  });

  it('skips deletion (no after)', async () => {
    seedRepo();
    seedOwnerUser();
    await handler(makeEvent({ state: 'open' }, undefined));
    expect(mockTriagePr).not.toHaveBeenCalled();
  });

  it('duplicate trigger delivery → no-op', async () => {
    mockMarkIdempotent.mockResolvedValue(false);
    seedRepo();
    seedOwnerUser();
    const prData = { state: 'open', title: 't' };
    seedPr(prData);
    await handler(makeEvent(undefined, prData));
    expect(mockTriagePr).not.toHaveBeenCalled();
  });

  it('no access token → logs and skips (no throw)', async () => {
    seedRepo();
    seedOwnerUser(null);
    const prData = { state: 'open', title: 't' };
    seedPr(prData);
    await handler(makeEvent(undefined, prData));
    expect(mockTriagePr).not.toHaveBeenCalled();
    expect(mockNotifyDiscord).not.toHaveBeenCalled();
  });

  it('repo doc missing → skips', async () => {
    seedOwnerUser();
    const prData = { state: 'open', title: 't' };
    seedPr(prData);
    await handler(makeEvent(undefined, prData));
    expect(mockTriagePr).not.toHaveBeenCalled();
  });

  it('repo.name unparseable → skips', async () => {
    seedRepo({ name: 'no-slash-here' });
    seedOwnerUser();
    const prData = { state: 'open', title: 't' };
    seedPr(prData);
    await handler(makeEvent(undefined, prData));
    expect(mockTriagePr).not.toHaveBeenCalled();
  });

  it('no Discord webhook url → still persists triage', async () => {
    seedRepo({ discordWebhookUrl: undefined });
    seedOwnerUser();
    const prData = { state: 'open', title: 't', authorLogin: 'alice' };
    seedPr(prData);

    await handler(makeEvent(undefined, prData));

    expect(mockTriagePr).toHaveBeenCalledTimes(1);
    const written = store.get(
      `apps/gitsync/repos/${REPO_ID}/pullRequests/${PR_NUMBER}`,
    );
    expect(written).toMatchObject({ triagedAt: '__ts__' });
    expect(mockNotifyDiscord).not.toHaveBeenCalled();
  });

  it('persists triage even if Discord notify rejects', async () => {
    seedRepo();
    seedOwnerUser();
    mockNotifyDiscord.mockRejectedValue(new Error('discord down'));
    const prData = { state: 'open', title: 't', authorLogin: 'alice' };
    seedPr(prData);

    // notifyDiscord already swallows in real code; if a hypothetical refactor
    // ever let it throw, the trigger should have written triagedAt FIRST.
    await expect(handler(makeEvent(undefined, prData))).rejects.toThrow();
    const written = store.get(
      `apps/gitsync/repos/${REPO_ID}/pullRequests/${PR_NUMBER}`,
    );
    expect(written).toMatchObject({ triagedAt: '__ts__' });
  });

  it('open → still-open update where before lacked triagedAt: runs triage', async () => {
    // Real path: draft PR opened first (no doc written), then ready_for_review
    // arrives → handler updates the same key from "didn't exist" → state=open.
    // Whatever the before, what matters is after.state===open && !after.triagedAt.
    seedRepo();
    seedOwnerUser();
    const before = { state: 'open' };
    const after = { state: 'open', title: 't', authorLogin: 'alice' };
    seedPr(after);
    await handler(makeEvent(before, after));
    expect(mockTriagePr).toHaveBeenCalledTimes(1);
  });
});
