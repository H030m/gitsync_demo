// Unit tests for the AGENTIC editDiscordDigestFlow. Verifies the lock gate
// (refuses a locked digest), the not-found guard, the happy-path AI rewrite +
// merge write, and that the agent can pull the day's raw messages via a tool
// before rewriting. Boundaries mocked: ../admin (fake Firestore doc), ../config
// (scripted OpenAI), ../tools/discordSearch (retrieval), firebase-admin/firestore
// (FieldValue + Timestamp), firebase-functions/v2 logger.

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
  Timestamp: { fromMillis: (ms: number) => ({ _ms: ms, toMillis: () => ms }) },
}));

const setSpy = jest.fn();
let docData: Record<string, unknown> | undefined;

jest.mock('../admin', () => ({
  db: {
    doc: (_path: string) => ({
      async get() {
        return { exists: docData !== undefined, data: () => docData };
      },
      async set(data: Record<string, unknown>, opts: unknown) {
        setSpy(data, opts);
        docData = { ...(docData ?? {}), ...data };
      },
    }),
  },
  REGION: 'asia-east1',
}));

// Scripted OpenAI: a queued tool-call turn (when present) drives the loop;
// otherwise create() returns a plain-content revised digest that the loop
// accepts as final (terminates in one round).
type ToolCall = { id: string; name: string; args: unknown };
const createQueue: Array<{ toolCalls: ToolCall[] }> = [];
const createSpy = jest.fn(async () => {
  const next = createQueue.shift();
  if (next) {
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: next.toolCalls.map((t) => ({
              id: t.id,
              type: 'function',
              function: { name: t.name, arguments: JSON.stringify(t.args) },
            })),
          },
        },
      ],
    };
  }
  return { choices: [{ message: { content: '# Revised\n- new bullet' } }] };
});

jest.mock('../config', () => ({
  getOpenAI: () => ({ chat: { completions: { create: createSpy } } }),
  MODELS: { fast: 'gpt-4o-mini' },
}));

const mockSearchDiscord = jest.fn(async (..._a: unknown[]) => [
  {
    channelId: 'chan',
    score: 1,
    messages: [
      {
        messageId: 'm1',
        channelId: 'chan',
        authorName: 'Alice',
        content: 'the migration is blocked on the index',
        isMatch: true,
        timestamp: null,
      },
    ],
  },
]);
jest.mock('../tools/discordSearch', () => ({
  searchDiscordMessages: (...a: unknown[]) => mockSearchDiscord(...a),
  getDaySummary: jest.fn(async () => null),
}));

import { editDiscordDigestFlow } from '../flows/editDiscordDigest';

describe('editDiscordDigestFlow', () => {
  beforeEach(() => {
    setSpy.mockClear();
    createSpy.mockClear();
    mockSearchDiscord.mockClear();
    createQueue.length = 0;
    docData = undefined;
  });

  it('throws not-found when the digest does not exist', async () => {
    await expect(
      editDiscordDigestFlow({ repoId: 'r', date: '2026-06-03', instruction: 'x' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('refuses to edit a locked digest (no OpenAI call, no write)', async () => {
    docData = { markdown: '# old', locked: true };
    await expect(
      editDiscordDigestFlow({ repoId: 'r', date: '2026-06-03', instruction: 'x' }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(createSpy).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('rewrites an unlocked digest and merge-writes the result', async () => {
    docData = { markdown: '# old', locked: false };
    const out = await editDiscordDigestFlow({
      repoId: 'r',
      date: '2026-06-03',
      instruction: 'make it shorter',
    });
    expect(out.markdown).toBe('# Revised\n- new bullet');
    expect(createSpy).toHaveBeenCalledTimes(1);
    const [written, opts] = setSpy.mock.calls[0];
    expect(written).toMatchObject({
      markdown: '# Revised\n- new bullet',
      lastEditInstruction: 'make it shorter',
    });
    expect(opts).toEqual({ merge: true });
  });

  it('agentically pulls the day\'s messages before rewriting', async () => {
    docData = { markdown: '# old', locked: false };
    // Round 1: the agent searches the raw messages. Round 2: it writes.
    createQueue.push({
      toolCalls: [
        { id: '1', name: 'searchDiscordMessages', args: { query: 'migration blocker' } },
      ],
    });
    createQueue.push({
      toolCalls: [
        {
          id: '2',
          name: 'writeDigest',
          args: { markdown: '# Revised\n- migration blocked on the index' },
        },
      ],
    });

    const out = await editDiscordDigestFlow({
      repoId: 'r',
      date: '2026-06-03',
      instruction: 'add what blocked the migration',
    });

    expect(out.markdown).toContain('blocked on the index');
    expect(mockSearchDiscord).toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(2);
    const [written] = setSpy.mock.calls[0];
    expect(written).toMatchObject({
      markdown: '# Revised\n- migration blocked on the index',
    });
  });
});
