// Unit tests for the discordChat callable handler — auth/validation and the
// optional time-scope range (startDate/endDate, both-or-neither, YYYY-MM-DD,
// same contract as getCommitGraph). The flow is mocked: we assert the handler
// forwards a valid range and rejects malformed ones.

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

jest.mock('../admin', () => ({ REGION: 'asia-east1' }));
jest.mock('../config', () => ({ openaiKey: { value: () => 'k' } }));

const flowSpy = jest.fn(async () => ({ answer: 'ok', snippets: [] }));
jest.mock('../flows/discordChat', () => ({ discordChatFlow: flowSpy }));

import { discordChat } from '../handlers/discordChat';

const handler = discordChat as unknown as (req: {
  auth: { uid: string } | null;
  data: Record<string, unknown>;
}) => Promise<{ answer: string }>;

const REPO = 'team17_gitsync';

beforeEach(() => flowSpy.mockClear());

describe('discordChat handler', () => {
  it('rejects an unauthenticated call', async () => {
    await expect(
      handler({ auth: null, data: { repoId: REPO, question: 'hi' } }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects a missing question', async () => {
    await expect(
      handler({ auth: { uid: 'u1' }, data: { repoId: REPO, question: '   ' } }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a half-open range (start without end)', async () => {
    await expect(
      handler({
        auth: { uid: 'u1' },
        data: { repoId: REPO, question: 'hi', startDate: '2026-06-01' },
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a malformed date', async () => {
    await expect(
      handler({
        auth: { uid: 'u1' },
        data: { repoId: REPO, question: 'hi', startDate: 'nope', endDate: '2026-06-05' },
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a reversed range', async () => {
    await expect(
      handler({
        auth: { uid: 'u1' },
        data: { repoId: REPO, question: 'hi', startDate: '2026-06-05', endDate: '2026-06-01' },
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('forwards a valid range to the flow', async () => {
    await handler({
      auth: { uid: 'u1' },
      data: { repoId: REPO, question: ' hi ', startDate: '2026-06-01', endDate: '2026-06-05' },
    });
    expect(flowSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: REPO,
        question: 'hi',
        startDate: '2026-06-01',
        endDate: '2026-06-05',
      }),
    );
  });

  it('omits the range when none is given (unchanged behavior)', async () => {
    await handler({ auth: { uid: 'u1' }, data: { repoId: REPO, question: 'hi' } });
    expect(flowSpy).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: undefined, endDate: undefined }),
    );
  });
});
