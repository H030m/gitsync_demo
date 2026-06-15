// Unit tests for the rolling project brief helpers (W3a) — tools/projectBrief.ts.
//
// Boundary mocks (assignTask.test.ts / summarizeDay.test.ts style):
//   - firebase-functions/v2 → logger no-op
//   - firebase-admin/firestore → FieldValue.serverTimestamp sentinel
//   - ../admin → hand-rolled fake Firestore (doc get/set)
//   - ../config → getOpenAI scripted per-test

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
}));

// ---- Fake Firestore -------------------------------------------------------

const store = new Map<string, Record<string, unknown>>();
const setSpy = jest.fn();
// When set, doc().get() throws this (simulates a read failure).
let getError: Error | null = null;
// When set, doc().set() throws this (simulates a write failure).
let setError: Error | null = null;

const fakeDb = {
  doc: (path: string) => ({
    path,
    async get() {
      if (getError) throw getError;
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    async set(data: Record<string, unknown>) {
      if (setError) throw setError;
      store.set(path, data);
      setSpy(path, data);
    },
  }),
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

// ---- Fake OpenAI ----------------------------------------------------------

const createQueue: Array<{ message: { content: string } }> = [];
let createError: Error | null = null;
const mockCreate = jest.fn(async () => {
  if (createError) throw createError;
  const next = createQueue.shift();
  if (!next) throw new Error('createQueue empty — test under-scripted OpenAI');
  return { choices: [next] };
});

jest.mock('../config', () => ({
  getOpenAI: () => ({ chat: { completions: { create: mockCreate } } }),
  MODELS: { reasoning: 'gpt-4o', fast: 'gpt-4o-mini', embedding: 'text-embedding-3-small' },
}));

import {
  readProjectBrief,
  formatBriefForPrompt,
  renderReportForBrief,
  mergeProjectBrief,
  MAX_BRIEF_CHARS,
} from '../tools/projectBrief';

// ---- Helpers --------------------------------------------------------------

const REPO = 'team17_gitsync';
const BRIEF_PATH = `apps/gitsync/repos/${REPO}/meta/projectBrief`;

function completionTurn(content: string) {
  return { message: { content } };
}

beforeEach(() => {
  store.clear();
  createQueue.length = 0;
  mockCreate.mockClear();
  setSpy.mockClear();
  getError = null;
  setError = null;
  createError = null;
});

// ---- readProjectBrief -----------------------------------------------------

describe('readProjectBrief', () => {
  it('returns null on a missing doc', async () => {
    await expect(readProjectBrief(REPO)).resolves.toBeNull();
  });

  it('returns a typed brief when present', async () => {
    store.set(BRIEF_PATH, { content: 'memory', updatedAt: '__ts__', version: 3 });
    await expect(readProjectBrief(REPO)).resolves.toEqual({
      content: 'memory',
      updatedAt: '__ts__',
      version: 3,
    });
  });

  it('returns null (does not throw) when the read fails', async () => {
    getError = new Error('boom');
    await expect(readProjectBrief(REPO)).resolves.toBeNull();
  });
});

// ---- formatBriefForPrompt -------------------------------------------------

describe('formatBriefForPrompt', () => {
  it('returns "" for null (byte-identical prompt)', () => {
    expect(formatBriefForPrompt(null)).toBe('');
  });

  it('returns "" for empty / whitespace content', () => {
    expect(
      formatBriefForPrompt({ content: '   ', updatedAt: null, version: 1 }),
    ).toBe('');
  });

  it('wraps non-empty content with a stable labelled block including the version', () => {
    const out = formatBriefForPrompt({
      content: '- uses OpenAI SDK',
      updatedAt: null,
      version: 5,
    });
    expect(out).toContain('## Project memory (accumulated over 5 daily report(s))');
    expect(out).toContain('- uses OpenAI SDK');
  });
});

// ---- renderReportForBrief -------------------------------------------------

describe('renderReportForBrief', () => {
  it('includes summary/highlights/blockers/themes and excludes member counts', () => {
    const out = renderReportForBrief({
      summary: 'Auth landed.',
      highlights: ['OAuth wired'],
      blockers: ['callback URL on Windows'],
      commitThemes: [{ theme: 'Auth', summary: 'OAuth provider added.' }],
    });
    expect(out).toContain('Summary: Auth landed.');
    expect(out).toContain('- OAuth wired');
    expect(out).toContain('- callback URL on Windows');
    expect(out).toContain('- Auth: OAuth provider added.');
    // No per-member contribution noise leaks in.
    expect(out).not.toMatch(/contribution|commits:\s*\d/i);
  });

  it('renders nothing for a trivially-empty report', () => {
    expect(
      renderReportForBrief({
        summary: '',
        highlights: [],
        blockers: [],
        commitThemes: [],
      }),
    ).toBe('');
  });
});

// ---- mergeProjectBrief ----------------------------------------------------

describe('mergeProjectBrief', () => {
  it('first run: one OpenAI call, writes version 1, truncated content', async () => {
    createQueue.push(completionTurn('# Brief\n- uses OpenAI SDK'));

    await mergeProjectBrief(REPO, 'Summary: Auth landed.');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(BRIEF_PATH, {
      content: '# Brief\n- uses OpenAI SDK',
      updatedAt: '__ts__',
      version: 1,
    });
  });

  it('subsequent run: version = old + 1', async () => {
    store.set(BRIEF_PATH, { content: 'old brief', updatedAt: '__ts__', version: 4 });
    createQueue.push(completionTurn('new brief'));

    await mergeProjectBrief(REPO, 'Summary: more work.');

    expect(setSpy).toHaveBeenCalledWith(
      BRIEF_PATH,
      expect.objectContaining({ content: 'new brief', version: 5 }),
    );
  });

  it('skips entirely (no OpenAI call, no write) when old + report are both empty', async () => {
    await mergeProjectBrief(REPO, '   ');

    expect(mockCreate).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('still merges when there is an existing brief but an empty report', async () => {
    store.set(BRIEF_PATH, { content: 'old brief', updatedAt: '__ts__', version: 2 });
    createQueue.push(completionTurn('refined brief'));

    await mergeProjectBrief(REPO, '');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(
      BRIEF_PATH,
      expect.objectContaining({ content: 'refined brief', version: 3 }),
    );
  });

  it('truncates over-long model output to <= MAX_BRIEF_CHARS with a marker', async () => {
    createQueue.push(completionTurn('x'.repeat(MAX_BRIEF_CHARS + 500)));

    await mergeProjectBrief(REPO, 'Summary: lots happened.');

    const written = setSpy.mock.calls[0][1] as { content: string };
    expect(written.content.length).toBe(MAX_BRIEF_CHARS);
    expect(written.content.endsWith('…')).toBe(true);
  });

  it('does not write when the model returns empty content', async () => {
    createQueue.push(completionTurn('   '));

    await mergeProjectBrief(REPO, 'Summary: something.');

    expect(setSpy).not.toHaveBeenCalled();
  });

  it('best-effort: an OpenAI failure does not throw and writes nothing', async () => {
    createError = new Error('429 rate limited');

    await expect(
      mergeProjectBrief(REPO, 'Summary: something.'),
    ).resolves.toBeUndefined();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('best-effort: a write failure does not throw', async () => {
    createQueue.push(completionTurn('a brief'));
    setError = new Error('write blew up');

    await expect(
      mergeProjectBrief(REPO, 'Summary: something.'),
    ).resolves.toBeUndefined();
  });
});
