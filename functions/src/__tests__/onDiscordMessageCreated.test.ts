// Unit tests for the onDiscordMessageCreated trigger (filter + embed).
//
// Boundary mocks:
//   - firebase-functions/v2/firestore → onDocumentCreated returns raw handler.
//   - firebase-functions/v2 → logger no-op.
//   - ../admin → fake Firestore (doc/update).
//   - ../tools/embedding → embedToFieldValue mocked.
//   - ../tools/idempotency → markIdempotent mocked.

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: (_opts: unknown, handler: unknown) => handler,
}));

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockMarkIdempotent = jest.fn();
jest.mock('../tools/idempotency', () => ({
  markIdempotent: (...args: unknown[]) => mockMarkIdempotent(...args),
}));

const mockEmbed = jest.fn();
jest.mock('../tools/embedding', () => ({
  embedToFieldValue: (...args: unknown[]) => mockEmbed(...args),
}));

jest.mock('../config', () => ({
  openaiKey: { value: () => 'k' },
}));

// ---- Fake Firestore -------------------------------------------------------

const store = new Map<string, Record<string, unknown>>();

const REPO_ID = 'octocat_hello';
const MSG_ID = '1700000000000';
const MSG_PATH = `apps/gitsync/repos/${REPO_ID}/discordMessages/${MSG_ID}`;

const updateSpy = jest.fn();

const fakeDb = {
  doc: (path: string) => ({
    path,
    async update(patch: Record<string, unknown>) {
      updateSpy(path, patch);
      store.set(path, { ...(store.get(path) ?? {}), ...patch });
    },
  }),
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

import { onDiscordMessageCreated } from '../triggers/onDiscordMessageCreated';

const handler = onDiscordMessageCreated as unknown as (
  event: unknown,
) => Promise<void>;

function makeEvent(content: string | undefined, id = 'evt-1') {
  const data = content === undefined ? {} : { content };
  store.set(MSG_PATH, { repoId: REPO_ID, channelId: 'c1', ...data });
  return {
    id,
    params: { repoId: REPO_ID, messageId: MSG_ID },
    data: { data: () => store.get(MSG_PATH) },
  };
}

beforeEach(() => {
  store.clear();
  updateSpy.mockReset();
  mockMarkIdempotent.mockReset().mockResolvedValue(true);
  mockEmbed.mockReset().mockResolvedValue({ __vector__: [0.1, 0.2] });
});

describe('onDiscordMessageCreated', () => {
  it('embeds a normal message and writes update.embedding', async () => {
    const event = makeEvent('we should refactor the OAuth flow next sprint');

    await handler(event);

    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockEmbed).toHaveBeenCalledWith(
      'we should refactor the OAuth flow next sprint',
    );
    expect(store.get(MSG_PATH)?.embedding).toEqual({ __vector__: [0.1, 0.2] });
  });

  it('filter hit (noise) → no embed, no update', async () => {
    const event = makeEvent('lol'); // matches the noise filter / < 5 chars

    await handler(event);

    expect(mockEmbed).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(store.get(MSG_PATH)?.embedding).toBeUndefined();
  });

  it('best-effort: embed failure leaves embedding null, does not throw', async () => {
    mockEmbed.mockRejectedValue(new Error('openai down'));
    const event = makeEvent('a genuinely substantive discussion message');

    await expect(handler(event)).resolves.toBeUndefined();
    // Nothing to persist → no update written.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(store.get(MSG_PATH)?.embedding).toBeUndefined();
  });

  it('missing content → no-op', async () => {
    const event = makeEvent(undefined);
    await handler(event);
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('duplicate delivery → no-op', async () => {
    mockMarkIdempotent.mockResolvedValue(false);
    const event = makeEvent('a genuinely substantive discussion message');
    await handler(event);
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
