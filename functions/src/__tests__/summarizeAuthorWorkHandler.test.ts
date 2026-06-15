// Unit tests for the summarizeAuthorWork callable handler (auth + arg
// validation). Boundary mocks per testing-guidelines: onCall → raw handler,
// the flow module is mocked (its own logic is covered in
// summarizeAuthorWork.test.ts).

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
jest.mock('../admin', () => ({ db: {}, REGION: 'asia-east1' }));
jest.mock('../config', () => ({ openaiKey: { name: 'OPENAI_API_KEY' } }));

const mockFlow = jest.fn(async (_input: unknown) => ({
  markdown: '- ok',
  cached: false,
}));
jest.mock('../flows/summarizeAuthorWork', () => ({
  summarizeAuthorWorkFlow: (input: unknown) => mockFlow(input),
}));

import { summarizeAuthorWork } from '../handlers/summarizeAuthorWork';

const call = summarizeAuthorWork as unknown as (req: {
  auth: { uid: string } | null;
  data: Record<string, unknown>;
}) => Promise<unknown>;

beforeEach(() => mockFlow.mockClear());

describe('summarizeAuthorWork handler', () => {
  it('rejects when unauthenticated', async () => {
    await expect(
      call({ auth: null, data: { repoId: 'r', login: 'a' } }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mockFlow).not.toHaveBeenCalled();
  });

  it('rejects when repoId is missing', async () => {
    await expect(
      call({ auth: { uid: 'u' }, data: { login: 'a' } }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(mockFlow).not.toHaveBeenCalled();
  });

  it('rejects when neither login nor names is provided', async () => {
    await expect(
      call({ auth: { uid: 'u' }, data: { repoId: 'r', names: ['  ', ''] } }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(mockFlow).not.toHaveBeenCalled();
  });

  it('delegates to the flow with normalized args (login present)', async () => {
    const res = await call({
      auth: { uid: 'u' },
      data: { repoId: 'r', login: 'alice', names: ['Alice'], force: true },
    });
    expect(res).toEqual({ markdown: '- ok', cached: false });
    expect(mockFlow).toHaveBeenCalledWith({
      repoId: 'r',
      login: 'alice',
      names: ['Alice'],
      force: true,
    });
  });

  it('accepts a name-only bucket (login absent)', async () => {
    await call({
      auth: { uid: 'u' },
      data: { repoId: 'r', names: ['倪嘉駿'] },
    });
    expect(mockFlow).toHaveBeenCalledWith({
      repoId: 'r',
      login: undefined,
      names: ['倪嘉駿'],
      force: false,
    });
  });
});
