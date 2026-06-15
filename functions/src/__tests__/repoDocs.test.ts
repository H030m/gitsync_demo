// Unit tests for readRepoPlanningDocs (tools/repoDocs).
//
// Boundary mocks per testing-guidelines:
//   - firebase-functions/v2 → logger no-op.
//   - ../admin → in-memory fake Firestore (doc get/set spy).
//   - ../services/githubClient → jest-mocked listRepoDir / getRepoFile, scripted
//     per-test via a path→value map so we never touch Octokit.
// The real `readRepoPlanningDocs` runs against these fakes.

jest.mock('firebase-functions/v2', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ---- Fake Firestore ---------------------------------------------------------

const store = new Map<string, Record<string, unknown>>();
const setSpy = jest.fn();
// Paths whose set() should reject — drives the best-effort cache-write test.
const setFailPaths = new Set<string>();

const fakeDb = {
  doc: (path: string) => ({
    path,
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    async set(data: Record<string, unknown>) {
      setSpy(path, data);
      if (setFailPaths.has(path)) throw new Error('boom: set failed');
      store.set(path, data);
    },
  }),
};

jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));

// ---- Fake githubClient ------------------------------------------------------
//
// dirs: path -> RepoEntry[] returned by listRepoDir (default []).
// files: path -> string | null returned by getRepoFile (default null).
// MAX_FILE_BYTES (30 KB) is enforced HERE (the real wrapper does it), so a test
// can register an oversized file and assert it's skipped.

interface RepoEntry {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size: number;
}

const dirs = new Map<string, RepoEntry[]>();
const files = new Map<string, { content: string; size: number }>();
const listSpy = jest.fn();
const getSpy = jest.fn();

jest.mock('../services/githubClient', () => ({
  listRepoDir: (_o: string, _r: string, _t: string, path: string) => {
    listSpy(path);
    return Promise.resolve(dirs.get(path) ?? []);
  },
  getRepoFile: (_o: string, _r: string, _t: string, path: string, maxBytes: number) => {
    getSpy(path);
    const f = files.get(path);
    if (!f) return Promise.resolve(null);
    if (f.size > maxBytes) return Promise.resolve(null);
    return Promise.resolve(f.content);
  },
}));

import { readRepoPlanningDocs } from '../tools/repoDocs';

// ---- Fixtures ---------------------------------------------------------------

const REPO = 'team17_gitsync';
const REPO_DOC_PATH = `apps/gitsync/repos/${REPO}`;
const CACHE_PATH = `apps/gitsync/repos/${REPO}/meta/repoDocsCache`;

/** Registers a directory listing of {name,type}, deriving path + size. */
function dir(
  path: string,
  entries: Array<{ name: string; type: 'file' | 'dir'; size?: number }>,
) {
  dirs.set(
    path,
    entries.map((e) => ({
      path: `${path}/${e.name}`,
      name: e.name,
      type: e.type,
      size: e.size ?? 0,
    })),
  );
}

/** Registers a file's content (size derived from byte length unless given). */
function file(path: string, content: string, size?: number) {
  files.set(path, { content, size: size ?? Buffer.byteLength(content) });
}

function seedOwnerToken() {
  store.set(REPO_DOC_PATH, { name: 'team17/gitsync', createdBy: 'u1' });
  store.set('apps/gitsync/users/u1', { githubAccessToken: 'tok' });
}

beforeEach(() => {
  store.clear();
  dirs.clear();
  files.clear();
  setSpy.mockClear();
  listSpy.mockClear();
  getSpy.mockClear();
  setFailPaths.clear();
  seedOwnerToken();
});

// ---- Cache ------------------------------------------------------------------

describe('readRepoPlanningDocs — cache', () => {
  it('returns a fresh cache hit without calling GitHub', async () => {
    store.set(CACHE_PATH, {
      content: '## cached',
      summary: '5/5 tasks done; all closed',
      source: 'trellis',
      taskCounts: { total: 5, todo: 0, in_progress: 0, done: 5, other: 0 },
      fetchedAt: Date.now(),
    });

    const res = await readRepoPlanningDocs(REPO);

    expect(res.cached).toBe(true);
    expect(res.content).toBe('## cached');
    expect(res.source).toBe('trellis');
    expect(res.taskCounts).toEqual({ total: 5, todo: 0, in_progress: 0, done: 5, other: 0 });
    expect(listSpy).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('ignores a stale cache and refetches + writes back', async () => {
    store.set(CACHE_PATH, {
      content: '## old',
      summary: 'old',
      source: 'trellis',
      fetchedAt: Date.now() - 11 * 60_000, // > 10 min TTL
    });
    dir('.trellis/tasks', [{ name: '06-12-a', type: 'dir' }]);
    file('.trellis/tasks/06-12-a/task.json', JSON.stringify({ title: 'A', status: 'todo' }));

    const res = await readRepoPlanningDocs(REPO);

    expect(res.cached).toBe(false);
    expect(res.source).toBe('trellis');
    expect(setSpy).toHaveBeenCalledWith(
      CACHE_PATH,
      expect.objectContaining({ fetchedAt: expect.any(Number), source: 'trellis' }),
    );
  });
});

// ---- .trellis happy path ----------------------------------------------------

describe('readRepoPlanningDocs — .trellis', () => {
  it('counts tasks, builds the progress list + summary, includes active prd.md', async () => {
    dir('.trellis/tasks', [
      { name: '06-10-done-one', type: 'dir' },
      { name: '06-11-in-prog', type: 'dir' },
      { name: '06-12-todo', type: 'dir' },
      { name: 'archive', type: 'dir' },
    ]);
    file('.trellis/tasks/06-10-done-one/task.json', JSON.stringify({ title: 'Done One', status: 'done' }));
    file('.trellis/tasks/06-11-in-prog/task.json', JSON.stringify({ title: 'In Prog', status: 'in_progress' }));
    file('.trellis/tasks/06-12-todo/task.json', JSON.stringify({ title: 'Todo Task', status: 'todo' }));
    // archive/<month>/<task> — two archived tasks counted as done.
    dir('.trellis/tasks/archive', [{ name: '2026-06', type: 'dir' }]);
    dir('.trellis/tasks/archive/2026-06', [
      { name: 'old-a', type: 'dir' },
      { name: 'old-b', type: 'dir' },
    ]);
    dir('.trellis/tasks/archive/2026-06/old-a', [{ name: 'task.json', type: 'file' }]);
    dir('.trellis/tasks/archive/2026-06/old-b', [{ name: 'task.json', type: 'file' }]);
    // active prd
    file('.trellis/tasks/06-11-in-prog/prd.md', '# In Prog PRD\nbody');

    const res = await readRepoPlanningDocs(REPO);

    expect(res.source).toBe('trellis');
    expect(res.taskCounts).toEqual({
      total: 5, // 3 active + 2 archived
      todo: 1,
      in_progress: 1,
      done: 3, // 1 active done + 2 archived
      other: 0,
    });
    expect(res.summary).toBe('3/5 tasks done; 2 open');
    expect(res.content).toContain('5 tasks — done 3 / in_progress 1 / todo 1');
    expect(res.content).toContain('- [done] Done One');
    expect(res.content).toContain('- [in_progress] In Prog');
    expect(res.content).toContain('## Active task: In Prog (in_progress)');
    expect(res.content).toContain('# In Prog PRD');
    // Archived task.json bodies are never fetched (Q1 ruling).
    expect(getSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('archive/2026-06/old-a/task.json'),
    );
  });

  it('caps active prd.md inclusion to the two most-recent active tasks', async () => {
    dir('.trellis/tasks', [
      { name: '06-01-a', type: 'dir' },
      { name: '06-02-b', type: 'dir' },
      { name: '06-03-c', type: 'dir' },
    ]);
    for (const [d, t] of [['06-01-a', 'A'], ['06-02-b', 'B'], ['06-03-c', 'C']] as const) {
      file(`.trellis/tasks/${d}/task.json`, JSON.stringify({ title: t, status: 'todo' }));
      file(`.trellis/tasks/${d}/prd.md`, `# ${t} PRD`);
    }

    const res = await readRepoPlanningDocs(REPO);

    const prdCount = (res.content.match(/## Active task:/g) ?? []).length;
    expect(prdCount).toBe(2);
  });
});

// ---- Fallback ---------------------------------------------------------------

describe('readRepoPlanningDocs — fallback', () => {
  it('falls back to README + docs/ listing when no planning docs exist', async () => {
    file('README.md', '# My Project\nhello');
    dir('docs', [
      { name: 'guide.md', type: 'file' },
      { name: 'api.md', type: 'file' },
    ]);

    const res = await readRepoPlanningDocs(REPO);

    expect(res.source).toBe('docs');
    expect(res.content).toContain('# My Project');
    expect(res.content).toContain('- docs/guide.md');
    expect(res.content).toContain('- docs/api.md');
    expect(res.taskCounts).toBeUndefined();
  });
});

// ---- None -------------------------------------------------------------------

describe('readRepoPlanningDocs — none', () => {
  it('returns an empty none result when nothing is found, without throwing', async () => {
    const res = await readRepoPlanningDocs(REPO);
    expect(res.source).toBe('none');
    expect(res.content).toBe('');
    expect(res.summary).toBe('no GitHub docs available');
  });
});

// ---- Truncation -------------------------------------------------------------

describe('readRepoPlanningDocs — truncation', () => {
  it('caps content to the char budget, keeps priority-1, marks truncation', async () => {
    dir('.trellis/tasks', [
      { name: '06-11-big-a', type: 'dir' },
      { name: '06-12-big-b', type: 'dir' },
    ]);
    file('.trellis/tasks/06-11-big-a/task.json', JSON.stringify({ title: 'Big A', status: 'in_progress' }));
    file('.trellis/tasks/06-12-big-b/task.json', JSON.stringify({ title: 'Big B', status: 'in_progress' }));
    // Two ~20 KB prds (each under the 30 KB per-file cap) — combined they overflow
    // the 32000-char budget, so the second prd section gets truncated.
    file('.trellis/tasks/06-11-big-a/prd.md', 'A'.repeat(20_000));
    file('.trellis/tasks/06-12-big-b/prd.md', 'B'.repeat(20_000));
    // A root AGENTS.md (priority 3) that must NOT appear — lower priority lost.
    file('AGENTS.md', 'AGENTS_MARKER_SHOULD_NOT_APPEAR');

    const res = await readRepoPlanningDocs(REPO);

    expect(res.content.length).toBeLessThanOrEqual(32_000);
    expect(res.content).toContain('…[truncated]');
    // Priority-1 progress survives.
    expect(res.content).toContain('- [in_progress] Big A');
    // Priority-3 section that would also overflow is dropped.
    expect(res.content).not.toContain('AGENTS_MARKER_SHOULD_NOT_APPEAR');
  });
});

// ---- Security filter --------------------------------------------------------

describe('readRepoPlanningDocs — security', () => {
  it('never fetches secrets/, .env, non-md, or oversized files under .claude', async () => {
    // No .trellis so we reach the .claude branch.
    dir('.claude', [
      { name: 'ok.md', type: 'file', size: 100 },
      { name: 'big.md', type: 'file', size: 40 * 1024 }, // > 30 KB
      { name: '.env', type: 'file', size: 50 },
      { name: 'logo.png', type: 'file', size: 100 },
      { name: 'secrets', type: 'dir' },
    ]);
    dir('.claude/secrets', [{ name: 'creds.md', type: 'file', size: 100 }]);
    file('.claude/ok.md', '# OK doc');
    file('.claude/big.md', 'X'.repeat(40 * 1024), 40 * 1024);
    file('.claude/.env', 'TOKEN=should-never-load');
    file('.claude/secrets/creds.md', 'password=hunter2');

    const res = await readRepoPlanningDocs(REPO);

    expect(res.content).toContain('# OK doc');
    // None of the unsafe / oversized / non-md paths were ever fetched.
    expect(getSpy).not.toHaveBeenCalledWith('.claude/big.md');
    expect(getSpy).not.toHaveBeenCalledWith('.claude/.env');
    expect(getSpy).not.toHaveBeenCalledWith('.claude/logo.png');
    expect(getSpy).not.toHaveBeenCalledWith('.claude/secrets/creds.md');
    // The secrets/ subdir is never even listed (defence in depth).
    expect(listSpy).not.toHaveBeenCalledWith('.claude/secrets');
  });
});

// ---- Missing token ----------------------------------------------------------

describe('readRepoPlanningDocs — missing token', () => {
  it('returns empty + never calls GitHub when createdBy is absent', async () => {
    store.set(REPO_DOC_PATH, { name: 'team17/gitsync' }); // no createdBy

    const res = await readRepoPlanningDocs(REPO);

    expect(res.source).toBe('none');
    expect(res.content).toBe('');
    expect(listSpy).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('returns empty when the owner user has no githubAccessToken', async () => {
    store.set('apps/gitsync/users/u1', {}); // owner doc exists, no token

    const res = await readRepoPlanningDocs(REPO);

    expect(res.source).toBe('none');
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('splits the slug on the first slash so repo names with "/" survive', async () => {
    // Defensive: name parsing uses indexOf('/'), preserving everything after.
    store.set(REPO_DOC_PATH, { name: 'team17/git/sync', createdBy: 'u1' });
    file('README.md', '# slug test');

    const res = await readRepoPlanningDocs(REPO);

    // owner='team17', repo='git/sync' — the fetch still runs (README found).
    expect(res.source).toBe('docs');
  });
});

// ---- Best-effort cache write ------------------------------------------------

describe('readRepoPlanningDocs — best-effort', () => {
  it('still returns the result when the cache write-back throws', async () => {
    dir('.trellis/tasks', [{ name: '06-12-a', type: 'dir' }]);
    file('.trellis/tasks/06-12-a/task.json', JSON.stringify({ title: 'A', status: 'done' }));
    setFailPaths.add(CACHE_PATH);

    const res = await readRepoPlanningDocs(REPO);

    expect(res.cached).toBe(false);
    expect(res.source).toBe('trellis');
    expect(res.taskCounts?.done).toBe(1);
    expect(setSpy).toHaveBeenCalledWith(CACHE_PATH, expect.any(Object));
  });
});
