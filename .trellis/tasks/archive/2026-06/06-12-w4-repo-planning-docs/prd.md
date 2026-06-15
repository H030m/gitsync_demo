# W4: readRepoPlanningDocs tool — agent reads repo .trellis/.claude/AGENTS docs

> **Status: PLANNING (not started).** This document is the implementation spec for
> Fable 5 to review before any `.ts` is written. Source spec: `FINAL_DEMO_PLAN.md` §W4.

## Goal

Teams already maintain planning context inside their repo — `.trellis/` (task.json +
prd.md), `AGENTS.md`, `CLAUDE.md`, `.claude/`, `docs/`. A new read-only tool
`readRepoPlanningDocs(repoId)` lets any agent **absorb that whole planning context at
zero extra input cost**: it fetches those files from the repo via the GitHub contents
API, compacts them into a single token-bounded markdown string suitable for prompt
injection, and caches the result.

Two payoffs for the demo:
1. `breakdownTaskFlow` knows **what work already exists** before it splits a goal, so it
   stops re-decomposing already-done work (directly strengthens midterm core feature 01,
   "read project context").
2. Demo easter egg: point GitSync at its **own** repo and ask "what's the progress?" — the
   agent reads its own `.trellis` and answers "53/54 tasks done, only FCM notifications
   open" (via W5, once this tool is registered there).

## Decisions (locked by the plan)

- **D1 — One pure async function.** `readRepoPlanningDocs(repoId: string): Promise<RepoDocsResult>`
  in `functions/src/tools/repoDocs.ts`. No `onCall` wrapper in this work item, no
  flow-specific coupling, no OpenAI calls. Same "thin, read-only, best-effort" shape as
  `tools/dailyIntel.ts` / `tools/assignTools.ts`. This lets W1 (`generateHandoff`) and W5
  (`askRepo`) register it as an OpenAI function-calling tool later with no refactor.
- **D2 — Token source = the repo OWNER's token, resolved inside the tool.** Unlike
  `getCommitGraph` (which uses the *caller's* token from the handler), this tool runs
  deep inside `breakdownTaskFlow`, which only receives `{ repoId, goal, requestedBy }` —
  **no token is threaded through.** So the tool resolves it itself:
  `repos/{repoId}.createdBy` → `users/{createdBy}.githubAccessToken`. (`createdBy` is the
  owner uid, written by `addRepo`; the owner always has `repo` scope since they registered
  the webhook.) This keeps the tool callable from any context without changing flow
  signatures.
- **D3 — Owner/repo slug resolution mirrors `getCommitGraph`.** `repoId` is
  `${owner}_${name}` and ambiguous when names contain `_`; resolve the real slug from
  `repos/{repoId}.name` ("owner/repo") by splitting on the first `/`.
- **D4 — Cache in Firestore, TTL 10 min.** `repos/{repoId}/meta/repoDocsCache`
  `{ content: string, fetchedAt: number (ms), summary: string, taskCounts?: {...} }`.
  Read-through + best-effort write-back, same pattern as `graphCache` in
  `flows/getCommitGraph.ts` (just a longer TTL). Protects the GitHub rate limit and makes
  repeated demo calls instant.
- **D5 — Output shape.**
  ```ts
  interface RepoDocsResult {
    content: string;            // formatted markdown, ready for prompt injection (<= ~8000 tokens)
    summary: string;            // one-line human summary, e.g. "53/54 tasks done; 1 open"
    taskCounts?: {              // present only when .trellis tasks were found
      total: number; todo: number; in_progress: number; done: number; other: number;
    };
    source: 'trellis' | 'docs' | 'none'; // which branch produced the content (debug/telemetry)
    cached: boolean;
  }
  ```

## Files to add / change

| File | Change |
|---|---|
| `functions/src/tools/repoDocs.ts` | **NEW.** The tool + helpers (token resolution, fetch pipeline, truncation, formatting). Pure read-only. |
| `functions/src/services/githubClient.ts` | **ADD** two thin wrappers (see "githubClient additions"). No edits to existing functions. |
| `functions/src/flows/breakdownTask.ts` | **CHANGE** Step 1 only: prepend the tool's `content` to `projectContext` (best-effort). No other step touched; the `isBreakingDown` lock stays in the handler. |
| `functions/src/__tests__/repoDocs.test.ts` | **NEW.** jest, boundary-mock `githubClient` + `db`. |

> **NOT changed in this work item:** `index.ts` (no new deployable export — the tool is not
> a callable yet), W1/W5 flows (they register it later), `firestore.rules`/`indexes`
> (`meta/` is Cloud-Functions-write-only via Admin SDK, no new index needed).

## githubClient additions (minimal — the spec assumed a contents API that doesn't exist yet)

`githubClient.ts` currently has **no contents/tree method** (only commits, graph, issues,
webhooks, repo access). Octokit is already a dependency and exposes `repos.getContent` and
`git.getTree`, so no new npm dependency is needed. Add two pure-fetch wrappers, matching the
file's "all GitHub API access lives here" discipline (ARCHITECTURE §6.4):

```ts
// List a directory's entries (GET /repos/{owner}/{repo}/contents/{path}).
// Returns [] when the path is missing (404) — callers treat "no docs" as normal.
listRepoDir(owner, repo, token, path): Promise<RepoEntry[]>
  // RepoEntry = { path: string; name: string; type: 'file' | 'dir'; size: number }

// Fetch one text file's decoded UTF-8 content (same endpoint, file path).
// Returns null on 404 or when size > maxBytes (caller passes 30*1024).
getRepoFile(owner, repo, token, path, maxBytes): Promise<string | null>
```

`getContent` returns base64-encoded `content` for files and an array for dirs; the wrapper
decodes/normalizes. We use the **contents API** (not the Git Trees API) because it lets us
walk only the paths we care about (`.trellis/tasks`, `.claude`, root files) instead of
pulling the whole tree — cheaper on a large repo and naturally path-scoped.

## Fetch-priority + truncation algorithm

Budget: **`TOKEN_BUDGET = 8000` tokens**, approximated as `~4 chars/token` →
`CHAR_BUDGET ≈ 32000` chars (we count chars, never call a tokenizer). Sections are appended
in priority order; once a section would overflow the remaining budget it is **truncated with
a `…[truncated]` marker** and **no lower-priority section that would also overflow is added**
(higher-priority context wins). Per-file hard cap = **30 KB** (skip larger files entirely).

```
readRepoPlanningDocs(repoId):
  0. cache: read meta/repoDocsCache; if fetchedAt within 10 min → return {…, cached:true}
  1. resolve owner/repo slug (repos/{repoId}.name) + owner token
        (users/{repos.createdBy}.githubAccessToken)
     if either missing → return EMPTY result {content:'', summary:'no GitHub docs available',
        source:'none', cached:false} (best-effort; never throw)
  2. budget = CHAR_BUDGET; parts = []

  --- PRIORITY 1: .trellis progress -------------------------------------------
  3. entries = listRepoDir('.trellis/tasks')   (also implicitly covers active tasks)
     for each task dir: getRepoFile('.trellis/tasks/<dir>/task.json')  (only .json, <=30KB)
        parse → collect { title, status }
     IGNORE the archive/ subdir for the per-task one-liner list, but DO count it toward
        totals (archived = done historically). [open question Q1]
     build:
        - taskCounts {total, todo, in_progress, done, other}
        - a compact progress list: "N tasks — done X / in_progress Y / todo Z" header +
          one line per NON-archived task: "- [status] title"
     summary = e.g. "53/54 tasks done; 1 open (FCM notifications)"
  --- PRIORITY 2: active task prd.md ------------------------------------------
  4. for the active (non-archived, status in {planning,in_progress,todo}) task(s),
        getRepoFile('.trellis/tasks/<dir>/prd.md'); include until budget pressure.
        Cap to the first ACTIVE_PRD_LIMIT (e.g. 2) tasks to stay bounded.
  --- PRIORITY 3: root AGENTS.md / CLAUDE.md ----------------------------------
  5. getRepoFile('AGENTS.md'), getRepoFile('CLAUDE.md'); append whichever exist.
  --- PRIORITY 4: .claude/**/*.md (names + first ~50 lines) -------------------
  6. listRepoDir('.claude') recursively (1–2 levels, MD only); for each .md file append
        "### <path>\n<first 50 lines>".
  --- FALLBACK (only if priorities 1–4 produced NOTHING) ----------------------
  7. getRepoFile('README.md') + listRepoDir('docs') → README body + a bullet list of
        docs/ filenames. source='docs'.

  8. content = parts.join('\n\n'), truncated to CHAR_BUDGET (marker on overflow)
  9. write-back cache {content, fetchedAt: Date.now(), summary, taskCounts} (best-effort)
 10. return { content, summary, taskCounts?, source, cached:false }
```

**File filter (applies to every fetch):** only extensions `.md` / `.json`; size ≤ 30 KB;
**never** descend into or read `secrets/`, `.env*`, or any non-text/binary path. Binary is
also implicitly excluded by the extension allow-list.

## Cache design

- Doc: `apps/gitsync/repos/{repoId}/meta/repoDocsCache`.
- Shape: `{ content, fetchedAt (ms epoch number), summary, taskCounts? }` — mirrors the
  `graphCache` `{ payload, generatedAtMs }` convention but stores the result fields directly.
- TTL: `CACHE_TTL_MS = 600_000` (10 min). Read-through: hit within TTL → return immediately
  with `cached:true`. Miss/stale → fetch, then best-effort write-back (a write failure logs
  `warn` and never fails the call, exactly like `graphCache`).
- `meta/` is Admin-SDK-write-only (no Firestore rule grants client writes), so no
  `firestore.rules` change. No composite index needed (single-doc get/set).
- No `force` param needed in this work item (breakdown/W1/W5 are fine with 10-min freshness);
  can be added later the same way `getCommitGraph` did.

## Security constraints (hard)

- **Allow-list only:** `.md` and `.json` files; everything else skipped.
- **Per-file cap 30 KB;** larger files skipped (not truncated-and-read).
- **NEVER** read `secrets/`, `.env*`, dotfiles holding credentials, or binaries. The fetch
  walks only known safe paths (`.trellis/tasks`, `.claude`, named root files, `docs/`) — it
  does not do an arbitrary repo-wide crawl, which structurally avoids secret paths.
- **Do not log document contents.** Logs carry only `repoId`, counts, sizes, `source`,
  cache hit/miss, and error strings — never file bodies (per `FINAL_DEMO_PLAN.md` §W4
  security note and `logging-guidelines.md`).
- Best-effort everywhere: any GitHub/Firestore failure degrades to an empty/partial result
  with a `logger.warn`, never an `HttpsError` (matches Rule D + `dailyIntel.ts` style).

## Integration point — breakdownTask

`flows/breakdownTask.ts` Step 1 currently builds `projectContext` from the repo doc only
and hardcodes *"This is a newly imported project — there are no existing tasks yet."*
Change: call `readRepoPlanningDocs(repoId)` and **prepend `result.content`** to
`projectContext` (only when non-empty; drop the "newly imported" line when docs exist).
Best-effort — if the tool returns empty, behavior is unchanged. No other step, and **not**
the `isBreakingDown` lock (handler-owned), is touched.

## Test plan (jest, boundary-mock)

Follow `testing-guidelines.md`: mock `../services/githubClient` and `../admin` `db`; call
the real `readRepoPlanningDocs`. New file `__tests__/repoDocs.test.ts`:
- **cache hit** within TTL → returns cached content, `cached:true`, **githubClient not called**.
- **cache miss** → fetches, returns `cached:false`, **write-back to `meta/repoDocsCache`** asserted.
- **.trellis happy path** → mocked task.json set yields correct `taskCounts` + progress list +
  `summary`; `source:'trellis'`.
- **fallback path** → no `.trellis`/`.claude`/AGENTS → README + docs listing; `source:'docs'`.
- **none path** → nothing found → empty content, `source:'none'`, no throw.
- **truncation** → oversized inputs → `content.length <= CHAR_BUDGET`, marker present,
  priority-1 content survives over priority-4.
- **security filter** → a mocked dir listing containing `secrets/x.json`, `.env`, `a.png`,
  and a 40 KB `.md` → none of them fetched/included.
- **missing token** (no `createdBy`/`githubAccessToken`) → empty result, no throw, GitHub not called.
- **best-effort** → cache write throws → main result still returned.
- (optional) a small breakdownTask test asserting `content` is prepended to the OpenAI
  user-message context when the tool returns non-empty.

Verify: `npm --prefix functions run typecheck` + `lint` + `test` all green (baseline already
recorded green: typecheck clean, 29 suites / 211 tests).

## Out of Scope

- Registering the tool as a callable / `index.ts` export (W1 & W5 own that).
- The OpenAI function-calling *registration* in `generateHandoff`/`askRepo` (W1/W5) — we only
  ship the pure function with a signature ready for it.
- Vector/semantic indexing of docs; this is a deterministic fetch + compact, no embeddings.
- A `force`/manual-refresh param or a UI surface.
- Crawling arbitrary repo paths or non-planning source files.
- Token encryption / KMS (tracked post-demo per the plan).

## Risks

- **Private repos / token scope.** Owner token may lack contents read for a private repo, or
  the repo is private and the token is read-public-only → 403/404. Mitigation: best-effort →
  empty result, breakdown still works on the repo-doc-only context.
- **Token expiry / revoked OAuth.** Owner's `githubAccessToken` can be stale. Mitigation:
  same best-effort degrade; surfaced only as a `warn`, never a user-facing error.
- **GitHub rate limits.** Walking `.trellis/tasks/*` is one `listRepoDir` + N `getRepoFile`
  calls; a repo with many tasks (this one has 50+ archived) could be dozens of requests.
  Mitigations: (a) 10-min cache makes repeated demo calls free; (b) the archive/ one-liner
  list is skipped so we don't fetch every archived `task.json` body — **but see Q1, counting
  archived totals may still need their task.json**; (c) per-section budget stops early.
- **Large `.trellis` dirs blowing the budget.** A repo with hundreds of tasks → progress list
  alone overflows 8000 tokens. Mitigation: progress list is compact (one line/task, header
  counts), and truncation keeps priority-1 first.
- **`createdBy` missing on legacy repo docs.** Older repos might lack `createdBy`. Mitigation:
  best-effort empty result; (optional follow-up) fall back to the first member with a token.
- **Octokit `getContent` shape variance.** Returns object for a file, array for a dir, and can
  return a `submodule`/`symlink` type. The wrapper normalizes and ignores non-`file`/`dir`
  types defensively.

## Technical Notes

- Token source contrast (documented so reviewers don't "fix" it to the caller token):
  `getCommitGraph` uses the **caller's** token because it runs in a handler with `request.auth`;
  this tool uses the **owner's** token because it runs inside a flow with no caller token.
- Char-budget heuristic (`~4 chars/token`) is intentional — no tokenizer dependency, matches
  the "don't make the LLM count / keep deterministic context cheap" discipline (ARCHITECTURE
  §5.5).
- Related files: `functions/src/{tools/repoDocs.ts, services/githubClient.ts,
  flows/breakdownTask.ts, __tests__/repoDocs.test.ts}`. Patterns reused:
  `flows/getCommitGraph.ts` (cache + slug/token resolution), `tools/dailyIntel.ts`
  (best-effort thin read-only tool), `tools/assignTools.ts` (members/users join shape).

## Open questions — RESOLVED (orchestrator rulings, 2026-06-12)

- **Q1 — Archived tasks in the count. RESOLVED → count archive dir ENTRIES as `done` by
  convention; do NOT fetch archived `task.json` bodies.** Archives may be nested by month
  (`archive/2026-06/<task>/`) — count task dirs, not month dirs. Implemented in
  `countArchivedTasks` (probes one level into each top-level archive entry: if it holds
  subdirs those are the tasks, else the entry is itself a flat task dir).
- **Q2 — "Active task" definition. RESOLVED → active = non-archived with
  `status ∈ {planning, in_progress, todo}`; include `prd.md` for at most the 2 most recent
  by directory name** (`ACTIVE_STATUSES` + `ACTIVE_PRD_LIMIT = 2`).
- **Q3 — Owner-token vs caller-token. RESOLVED → owner token** via
  `repos/{repoId}.createdBy` → `users/{createdBy}.githubAccessToken`; flow signatures
  unchanged (`resolveRepoContext`).
- **Q4 — Demo repo privacy. RESOLVED → human check before the demo, out of code scope.**
  Proceeded.
