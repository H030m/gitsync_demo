// readRepoPlanningDocs — a thin, read-only, best-effort tool that absorbs a
// repo's *planning context* (its in-repo `.trellis/` tasks, `AGENTS.md` /
// `CLAUDE.md`, `.claude/**/*.md`, or a `README` + `docs/` fallback) into one
// token-bounded markdown string suitable for prompt injection, and caches it.
//
// Design mirrors `tools/dailyIntel.ts` / `tools/assignTools.ts`:
//   - one pure async function, no `onCall` wrapper, never calls OpenAI;
//   - BEST-EFFORT — any GitHub/Firestore failure degrades to an empty/partial
//     result + a `logger.warn`, never an `HttpsError` (Rule D, prd "Security").
//
// Token source contrast (do NOT "fix" this to the caller's token): unlike
// `getCommitGraph` (which uses the *caller's* token from its handler), this tool
// runs deep inside `breakdownTaskFlow`, which threads no token through. So it
// resolves the repo OWNER's token itself: `repos/{repoId}.createdBy` →
// `users/{createdBy}.githubAccessToken` (prd D2/D3).
import { logger } from 'firebase-functions/v2';

import { db } from '../admin';
import {
  listRepoDir,
  getRepoFile,
  type RepoEntry,
} from '../services/githubClient';

export interface RepoDocsResult {
  /** Formatted markdown, ready for prompt injection (<= CHAR_BUDGET chars). */
  content: string;
  /** One-line human summary, e.g. "53/54 tasks done; 1 open". */
  summary: string;
  /** Present only when `.trellis` tasks were found. */
  taskCounts?: {
    total: number;
    todo: number;
    in_progress: number;
    done: number;
    other: number;
  };
  /** Which branch produced the content (debug/telemetry). */
  source: 'trellis' | 'docs' | 'none';
  cached: boolean;
}

/** ~8000-token budget, approximated at ~4 chars/token (no tokenizer dep). */
const TOKEN_BUDGET = 8000;
const CHAR_BUDGET = TOKEN_BUDGET * 4; // 32000 chars
/** Per-file hard cap — files larger than this are skipped entirely. */
const MAX_FILE_BYTES = 30 * 1024; // 30 KB
/** Cache TTL — repeated demo/breakdown calls within the window are instant. */
const CACHE_TTL_MS = 600_000; // 10 min
/** At most this many active tasks contribute their prd.md (prd Q2). */
const ACTIVE_PRD_LIMIT = 2;
/** First N lines of each `.claude/**` markdown file are surfaced. */
const CLAUDE_FILE_HEAD_LINES = 50;
/** Recursion depth cap for the `.claude` walk (prd priority 4: 1–2 levels). */
const CLAUDE_MAX_DEPTH = 2;
/** Statuses that mark a non-archived task as "active" (prd Q2). */
const ACTIVE_STATUSES = new Set(['planning', 'in_progress', 'todo']);
/** Marker appended when a section is cut to fit the budget. */
const TRUNCATE_MARKER = '\n…[truncated]';

const EMPTY_RESULT: RepoDocsResult = {
  content: '',
  summary: 'no GitHub docs available',
  source: 'none',
  cached: false,
};

interface TaskMeta {
  dir: string; // task directory name (e.g. "06-12-w4-...")
  title: string;
  status: string;
}

/**
 * Reads the repo's planning docs and returns a compacted, token-bounded
 * markdown string for prompt injection. Read-through Firestore cache (10-min
 * TTL); best-effort write-back. NEVER throws — every failure degrades to an
 * empty/partial result with a `logger.warn`.
 */
export async function readRepoPlanningDocs(
  repoId: string,
): Promise<RepoDocsResult> {
  // ---- 0. Cache read (best-effort) -----------------------------------------
  const cacheRef = db.doc(`apps/gitsync/repos/${repoId}/meta/repoDocsCache`);
  try {
    const snap = await cacheRef.get();
    const data = snap.data();
    if (data) {
      const age = Date.now() - ((data.fetchedAt as number) ?? 0);
      if (age < CACHE_TTL_MS) {
        logger.info('readRepoPlanningDocs: cache hit', { repoId });
        return {
          content: (data.content as string) ?? '',
          summary: (data.summary as string) ?? '',
          taskCounts: data.taskCounts as RepoDocsResult['taskCounts'],
          source: (data.source as RepoDocsResult['source']) ?? 'none',
          cached: true,
        };
      }
    }
  } catch (err) {
    logger.warn('readRepoPlanningDocs: cache read failed (best-effort)', {
      repoId,
      err: String(err),
    });
  }

  // ---- 1. Resolve owner/repo slug + owner token ----------------------------
  let ctx: { owner: string; repo: string; token: string };
  try {
    const resolved = await resolveRepoContext(repoId);
    if (!resolved) {
      logger.info('readRepoPlanningDocs: no slug/owner token; empty result', {
        repoId,
      });
      return { ...EMPTY_RESULT };
    }
    ctx = resolved;
  } catch (err) {
    logger.warn('readRepoPlanningDocs: context resolution failed (best-effort)', {
      repoId,
      err: String(err),
    });
    return { ...EMPTY_RESULT };
  }

  // ---- 2-7. Fetch + assemble (best-effort) ---------------------------------
  let result: RepoDocsResult;
  try {
    result = await fetchAndAssemble(ctx.owner, ctx.repo, ctx.token);
  } catch (err) {
    logger.warn('readRepoPlanningDocs: fetch failed (best-effort)', {
      repoId,
      err: String(err),
    });
    return { ...EMPTY_RESULT };
  }

  logger.info('readRepoPlanningDocs: assembled docs', {
    repoId,
    source: result.source,
    chars: result.content.length,
    taskCounts: result.taskCounts,
  });

  // ---- 8. Cache write-back (best-effort) -----------------------------------
  try {
    await cacheRef.set({
      content: result.content,
      summary: result.summary,
      source: result.source,
      ...(result.taskCounts ? { taskCounts: result.taskCounts } : {}),
      fetchedAt: Date.now(),
    });
  } catch (err) {
    logger.warn('readRepoPlanningDocs: cache write failed (best-effort)', {
      repoId,
      err: String(err),
    });
  }

  return result;
}

/**
 * Resolves the repo's GitHub slug ("owner/name", split on the FIRST `/` so
 * names containing `_` stay intact — prd D3) and the OWNER's access token
 * (`repos.createdBy` → `users/{createdBy}.githubAccessToken`, prd D2). Returns
 * null when any piece is missing so the caller can degrade to an empty result.
 *
 * Exported (shared by `tools/handoffTools.ts`'s getCommitDiff, which needs the
 * same owner/repo/token resolution) — keep the logic in one place (prd W1 Q2).
 */
export async function resolveRepoContext(
  repoId: string,
): Promise<{ owner: string; repo: string; token: string } | null> {
  const repoSnap = await db.doc(`apps/gitsync/repos/${repoId}`).get();
  const repoData = repoSnap.data();
  if (!repoData) return null;

  const slug = (repoData.name as string | undefined) ?? '';
  const slash = slug.indexOf('/');
  if (slash <= 0 || slash === slug.length - 1) return null;
  const owner = slug.slice(0, slash);
  const repo = slug.slice(slash + 1);

  const createdBy = repoData.createdBy as string | undefined;
  if (!createdBy) return null;

  const userSnap = await db.doc(`apps/gitsync/users/${createdBy}`).get();
  const token = userSnap.data()?.githubAccessToken as string | undefined;
  if (!token) return null;

  return { owner, repo, token };
}

/**
 * Runs the prd fetch-priority pipeline (.trellis → active prd.md → AGENTS/CLAUDE
 * → .claude/**.md → README/docs fallback) and packs the sections into a single
 * markdown string under CHAR_BUDGET. Sections are appended in priority order;
 * once a section would overflow the remaining budget it is truncated and no
 * lower-priority section that would also overflow is added (higher-priority
 * context wins — prd "Fetch-priority + truncation").
 */
async function fetchAndAssemble(
  owner: string,
  repo: string,
  token: string,
): Promise<RepoDocsResult> {
  const get = (path: string) => getRepoFile(owner, repo, token, path, MAX_FILE_BYTES);
  const list = (path: string) => listRepoDir(owner, repo, token, path);

  const parts: string[] = [];
  let source: RepoDocsResult['source'] = 'none';
  let summary = '';
  let taskCounts: RepoDocsResult['taskCounts'] | undefined;

  // ---- Priority 1: .trellis progress --------------------------------------
  const trellis = await readTrellisProgress(get, list);
  if (trellis) {
    source = 'trellis';
    taskCounts = trellis.counts;
    summary = trellis.summary;
    parts.push(trellis.progressBlock);

    // ---- Priority 2: active task prd.md ------------------------------------
    for (const t of trellis.activeTasks.slice(0, ACTIVE_PRD_LIMIT)) {
      const prd = await get(`.trellis/tasks/${t.dir}/prd.md`);
      if (prd && prd.trim()) {
        parts.push(`## Active task: ${t.title} (${t.status})\n\n${prd.trim()}`);
      }
    }
  }

  // ---- Priority 3: root AGENTS.md / CLAUDE.md ------------------------------
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const body = await get(name);
    if (body && body.trim()) {
      if (source === 'none') source = 'trellis';
      parts.push(`## ${name}\n\n${body.trim()}`);
    }
  }

  // ---- Priority 4: .claude/**/*.md (names + first lines) -------------------
  const claudeFiles = await listMarkdownRecursive(list, '.claude', CLAUDE_MAX_DEPTH);
  for (const file of claudeFiles) {
    const body = await get(file.path);
    if (body && body.trim()) {
      if (source === 'none') source = 'trellis';
      const head = body.split('\n').slice(0, CLAUDE_FILE_HEAD_LINES).join('\n');
      parts.push(`### ${file.path}\n\n${head.trim()}`);
    }
  }

  // ---- Fallback: README + docs/ listing (only if 1–4 found nothing) -------
  if (parts.length === 0) {
    const readme = await get('README.md');
    if (readme && readme.trim()) {
      source = 'docs';
      parts.push(`## README.md\n\n${readme.trim()}`);
    }
    const docs = await list('docs');
    const docFiles = docs.filter((e) => e.type === 'file');
    if (docFiles.length > 0) {
      source = 'docs';
      const bullets = docFiles.map((e) => `- ${e.path}`).join('\n');
      parts.push(`## docs/\n\n${bullets}`);
    }
  }

  if (parts.length === 0) return { ...EMPTY_RESULT };

  const content = packToBudget(parts, CHAR_BUDGET);
  if (!summary) summary = source === 'docs' ? 'repo docs available' : 'repo planning docs available';

  return { content, summary, taskCounts, source, cached: false };
}

/**
 * Reads `.trellis/tasks`, parsing each active task's `task.json` for its
 * title/status and counting archived task dirs as `done` by convention without
 * fetching their bodies (prd Q1 ruling). Returns null when `.trellis/tasks`
 * doesn't exist.
 */
async function readTrellisProgress(
  get: (path: string) => Promise<string | null>,
  list: (path: string) => Promise<RepoEntry[]>,
): Promise<{
  counts: NonNullable<RepoDocsResult['taskCounts']>;
  summary: string;
  progressBlock: string;
  activeTasks: TaskMeta[];
} | null> {
  const entries = await list('.trellis/tasks');
  if (entries.length === 0) return null;

  const taskDirs = entries.filter(
    (e) => e.type === 'dir' && e.name !== 'archive',
  );
  const hasArchive = entries.some(
    (e) => e.type === 'dir' && e.name === 'archive',
  );

  // Active (non-archived) tasks: parse each task.json for title + status.
  const tasks: TaskMeta[] = [];
  for (const dir of taskDirs) {
    const raw = await get(`.trellis/tasks/${dir.name}/task.json`);
    if (!raw) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue; // skip an unparseable task.json, never throw
    }
    tasks.push({
      dir: dir.name,
      title: (parsed.title as string | undefined) ?? dir.name,
      status: (parsed.status as string | undefined) ?? 'other',
    });
  }

  // Archived task dirs count as `done` by convention (prd Q1) — no body fetch.
  // Archives may be nested by month (archive/2026-06/<task>/); count task dirs,
  // not month dirs, by walking one level into each month subdir when present.
  const archivedDone = hasArchive ? await countArchivedTasks(list) : 0;

  const counts = { total: 0, todo: 0, in_progress: 0, done: 0, other: 0 };
  for (const t of tasks) {
    counts.total += 1;
    switch (t.status) {
      case 'todo':
        counts.todo += 1;
        break;
      case 'in_progress':
        counts.in_progress += 1;
        break;
      case 'done':
        counts.done += 1;
        break;
      default:
        counts.other += 1;
    }
  }
  counts.total += archivedDone;
  counts.done += archivedDone;

  const activeTasks = tasks.filter((t) => ACTIVE_STATUSES.has(t.status));
  const openCount = counts.todo + counts.in_progress + counts.other;

  const header =
    `${counts.total} tasks — done ${counts.done} / ` +
    `in_progress ${counts.in_progress} / todo ${counts.todo}` +
    (counts.other ? ` / other ${counts.other}` : '');
  const lines = tasks.map((t) => `- [${t.status}] ${t.title}`);
  const progressBlock = `## Project progress (.trellis)\n\n${header}\n${lines.join('\n')}`;

  const summary =
    openCount === 0
      ? `${counts.done}/${counts.total} tasks done; all closed`
      : `${counts.done}/${counts.total} tasks done; ${openCount} open`;

  return { counts, summary, progressBlock, activeTasks };
}

/**
 * Counts archived task directories under `.trellis/tasks/archive`, descending
 * one level into month subdirs (e.g. `archive/2026-06/<task>/`) so months are
 * not miscounted as tasks (prd Q1 ruling). A flat `archive/<task>/` layout is
 * also handled. Never fetches task.json bodies.
 */
async function countArchivedTasks(
  list: (path: string) => Promise<RepoEntry[]>,
): Promise<number> {
  const top = await list('.trellis/tasks/archive');
  const dirs = top.filter((e) => e.type === 'dir');
  let count = 0;
  for (const d of dirs) {
    // A month bucket (e.g. "2026-06") holds task dirs; a task dir holds files.
    // Probe one level: if it contains subdirs, those are the tasks; otherwise
    // this entry is itself a task dir (flat layout).
    const sub = await list(d.path);
    const subDirs = sub.filter((e) => e.type === 'dir');
    count += subDirs.length > 0 ? subDirs.length : 1;
  }
  return count;
}

/**
 * Lists `.md` files under `root`, recursing up to `maxDepth` levels. Applies the
 * security allow-list implicitly via the extension check and the path filter
 * (`secrets/` and `.env*` are never descended into). Best-effort — a failed
 * sub-listing is skipped.
 */
async function listMarkdownRecursive(
  list: (path: string) => Promise<RepoEntry[]>,
  root: string,
  maxDepth: number,
): Promise<RepoEntry[]> {
  const out: RepoEntry[] = [];
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    const entries = await list(path);
    for (const e of entries) {
      if (!isSafePath(e.path)) continue;
      if (e.type === 'file') {
        if (e.name.toLowerCase().endsWith('.md') && e.size <= MAX_FILE_BYTES) {
          out.push(e);
        }
      } else if (e.type === 'dir') {
        await walk(e.path, depth + 1);
      }
    }
  };
  await walk(root, 1);
  return out;
}

/**
 * Hard security filter (prd "Security constraints"): rejects any path under a
 * `secrets/` segment or whose basename starts with `.env`. The fetch only walks
 * known planning paths, so this is defence-in-depth against an unexpected
 * listing entry — never read a credential file.
 */
function isSafePath(path: string): boolean {
  const segments = path.split('/');
  if (segments.some((s) => s === 'secrets')) return false;
  const base = segments[segments.length - 1] ?? '';
  if (base.toLowerCase().startsWith('.env')) return false;
  return true;
}

/**
 * Joins `parts` with blank lines, capping the total at `budget` chars. Sections
 * are added whole while they fit; the first section that would overflow is
 * truncated with a marker and no further section is appended (priority-1 context
 * survives over priority-4 — prd truncation algorithm).
 */
function packToBudget(parts: string[], budget: number): string {
  const sep = '\n\n';
  let out = '';
  for (const part of parts) {
    const candidate = out ? out + sep + part : part;
    if (candidate.length <= budget) {
      out = candidate;
      continue;
    }
    // This section overflows: truncate it to fill the remaining budget, then
    // stop (no lower-priority section is added).
    const used = out ? out.length + sep.length : 0;
    const room = budget - used - TRUNCATE_MARKER.length;
    if (room > 0) {
      const slice = part.slice(0, room) + TRUNCATE_MARKER;
      out = out ? out + sep + slice : slice;
    }
    break;
  }
  return out;
}
