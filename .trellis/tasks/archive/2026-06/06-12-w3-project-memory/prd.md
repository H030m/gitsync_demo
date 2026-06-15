# W3: Project memory — rolling projectBrief (W3a) + expertiseTags learning (W3b)

> **Status: IMPLEMENTED (approved plan, all Qs resolved).** Source spec:
> `docs/FINAL_DEMO_PLAN.md` §W3. Baseline (verified in `gitsync-w3`): typecheck **0 errors**,
> jest **33 suites / 250 tests**. After implementation: typecheck **0 errors**, lint clean,
> jest **34 suites / 280 tests**.

## Goal

Give the Agentic Map's weakest box — **Memory** — a story that visibly *grows*. Two
independent, best-effort additions, both feeding the "the agent understands your project
and your teammates more every day" narrative:

- **W3a — rolling project brief.** A single per-repo markdown brief
  (`repos/{repoId}/meta/projectBrief`) that the daily-report flow re-summarizes every run.
  Day 1 it is empty; day 10 it encodes the team's conventions, recurring blockers, and
  tech choices. All downstream agent flows prepend it to their context as a stable,
  cache-friendly prefix, so every agent benefits from accumulated understanding. Demo can
  show the brief content directly.
- **W3b — member expertise learning.** When `assignTaskFlow` finalizes a decision, the
  agent additionally emits `learnedTags` derived from the commit evidence it actually
  retrieved. These merge into the assignee's `expertiseTags`. The next assignment reads
  them back via `readTeamState` — **the agent's last decision becomes its next input.**

Both are **best-effort**: a failure NEVER fails the host operation (the report still
persists; the assignment still applies). Both leave behavior unchanged when empty.

---

## ⚠️ Reality-vs-spec discrepancies (resolve before coding)

1. **`expertiseTags` live on the `users` doc, NOT the `members` doc.**
   `FINAL_DEMO_PLAN.md` §W3b says "merge into `members/{userId}.expertiseTags`". That is
   **wrong against the real schema.** `tools/assignTools.ts::readTeamState` joins
   `repos/{repoId}/members/{userId}` (workload: `activeIssueCount`, `lastActiveAt`) with
   `apps/gitsync/users/{userId}` (identity + `expertiseTags`), and reads
   `expertiseTags` from the **users** doc (`assignTools.ts:47`). `docs/ARCHITECTURE.md:99`
   confirms `users/{userId}.expertiseTags: string[]  # 自動學習`. **Write-back MUST target
   `apps/gitsync/users/{userId}.expertiseTags`** or `readTeamState` will never read it back
   and the demo loop breaks. (See Risk + Open Question Q1.)

2. **The users doc may not pre-exist for a member.** `readTeamState` explicitly tolerates a
   missing users doc ("Members with a missing users doc still appear … so the agent never
   silently loses a candidate"). Therefore the write-back must use
   `set({ expertiseTags: arrayUnion(...) }, { merge: true })`, **not** `update()` (which
   throws `5 NOT_FOUND` on a missing doc). This is different from `applyAssignment`, which
   uses `update()` on the members doc that `addRepo`/`importCollaborators` guarantee exists.

3. **`finalizeAssignment` writes today via `applyAssignment` only.** In `flows/assignTask.ts`
   the finalize branch (lines 188–207) validates `assigneeId ∈ memberIds`, calls
   `applyAssignment(repoId, taskId, assigneeId)` (a transaction in `tools/taskStatus.ts`
   that sets `tasks/{taskId}.assigneeId` and rebalances member `activeIssueCount`), and
   returns `{ assigneeId, reasoning }`. There is **no** existing tags write. W3b adds the
   tags merge as a **separate best-effort step after** `applyAssignment` returns — it is NOT
   folded into the `applyAssignment` transaction (different doc, different collection,
   best-effort vs. must-succeed).

4. **`meta/` is the established subcollection for repo-scoped singleton caches.** W4 already
   uses `repos/{repoId}/meta/repoDocsCache`. `projectBrief` is a sibling doc
   `repos/{repoId}/meta/projectBrief`. `meta/` is Admin-SDK-write-only (no client write rule),
   so **no `firestore.rules` or `firestore.indexes.json` change** is needed (single-doc
   get/set, no query).

---

## Files to add / change

| File | Change |
|---|---|
| `functions/src/tools/projectBrief.ts` | **NEW.** Pure read/merge helpers: `readProjectBrief(repoId)`, `formatBriefForPrompt(brief)`, `mergeProjectBrief(repoId, oldBrief, todayReportText)` (the one MODELS.fast call + write), plus the `MAX_TAGS` / cap helper if we co-locate W3b's merge — see note. No `onCall` wrapper. Best-effort, never throws. |
| `functions/src/prompts/projectBrief.ts` | **NEW.** `projectBriefMergeSystem` + `projectBriefMergeUser({ oldBrief, report })` — the anti-bloat merge prompt (see "Brief-merge prompt design"). |
| `functions/src/flows/summarizeDay.ts` | **CHANGE.** Add **Step 4** after the report `.set()` (after line 212): best-effort `mergeProjectBrief(...)`. No change to Steps 1–3 or the return shape. |
| `functions/src/flows/breakdownTask.ts` | **CHANGE.** Step 1 only: prepend `formatBriefForPrompt(readProjectBrief(repoId))` to `projectContext`, ABOVE the repoDocs block (stable prefix first). Best-effort. |
| `functions/src/flows/assignTask.ts` | **CHANGE.** (a) prepend the formatted brief to the system/context (see "Read points"); (b) extend the `finalizeAssignment` tool schema with `learnedTags?: string[]`; (c) after `applyAssignment` in the finalize branch, best-effort merge tags into the assignee's `users` doc. |
| `functions/src/prompts/assignTask.ts` | **CHANGE.** Add one rule instructing the agent to emit `learnedTags` ONLY from evidence it actually retrieved (anti-hallucination), 1–4 short lowercase tags. |
| `functions/src/flows/generateHandoff.ts` | **CHANGE.** Prepend the formatted brief to the user-message context (stable prefix). Best-effort. |
| `functions/src/flows/dailyBriefChat.ts` | **CHANGE.** Prepend the formatted brief into the system message (stable, before history + question). Best-effort. |
| `functions/src/__tests__/projectBrief.test.ts` | **NEW.** Unit tests for the tool helpers (read/format/merge/cap). |
| `functions/src/__tests__/summarizeDay.test.ts` | **CHANGE.** Add cases for the brief write step; extend the firestore mock (`arrayUnion` not needed here; `doc().set()` already supported — but `mergeProjectBrief` does a `get` then `set`, already supported). |
| `functions/src/__tests__/assignTask.test.ts` | **CHANGE.** Add `learnedTags` write-back cases; extend the firestore mock with an `arrayUnion` sentinel + `set(data, options)` on `doc()` (current mock `doc()` has no `set`). |

> **NOT changed:** `firestore.rules`, `firestore.indexes.json` (meta/ singleton, no query),
> `config.ts` (reuse `MODELS.fast`), `index.ts` (no new deployable export — both pieces hook
> into existing flows), W5's `askRepo` (does not exist yet; W5 will prepend the brief itself).

> **Co-location note (open for Fable 5):** W3b's tag-merge is small. Options: (i) put a
> `mergeLearnedTags(repoId, userId, tags)` helper in `tools/projectBrief.ts` (groups all
> "memory write-back" in one module), or (ii) put it in `tools/assignTools.ts` (groups it with
> the assign-domain reads). Default proposal: **(ii) `tools/assignTools.ts`** — it lives next
> to `readTeamState` which reads the same field, keeping the read/write of `expertiseTags` in
> one file. `projectBrief.ts` stays W3a-only. (Q4.)

---

## W3a — Project brief data model

`apps/gitsync/repos/{repoId}/meta/projectBrief`:

```ts
interface ProjectBrief {
  content: string;        // markdown, hard cap ~3500 chars (~500 words)
  updatedAt: Timestamp;   // FieldValue.serverTimestamp() on each merge
  version: number;        // 0 → 1 → 2 …; increments every successful merge
}
```

- **Hard cap:** `MAX_BRIEF_CHARS = 3500` (~500 words at ~7 chars/word incl. spaces). Two-layer
  enforcement: the merge prompt *demands* ≤500 words, AND we **deterministically truncate**
  the model output to `MAX_BRIEF_CHARS` (with a `…` marker) before writing — never trust the
  model to respect the cap (prevents unbounded growth = the named "hard part").
- **Empty/first run:** no doc → `readProjectBrief` returns `null`; `formatBriefForPrompt(null)`
  returns `''` (zero prompt change); the first merge writes `version: 1`.

### Read helpers (`tools/projectBrief.ts`)

```ts
// Best-effort read. Returns null on missing doc or any error (logger.warn). Never throws.
async function readProjectBrief(repoId: string): Promise<ProjectBrief | null>

// Pure formatter. null/empty → ''. Otherwise wraps content in a stable, labelled block:
//   "## Project memory (accumulated over N daily reports)\n\n<content>\n"
// The label + content are STABLE across a day (only changes when version bumps), so placing
// it at the TOP of the system/context message preserves the prompt-cache prefix.
function formatBriefForPrompt(brief: ProjectBrief | null): string
```

### Write step (`tools/projectBrief.ts::mergeProjectBrief`, called from `summarizeDayFlow`)

```ts
// Best-effort. Never throws — caller wraps in try/catch AND this swallows internally.
async function mergeProjectBrief(
  repoId: string,
  reportText: string,   // a compact text rendering of today's SummarizeDayResult
): Promise<void>
```

Algorithm:
1. `old = await readProjectBrief(repoId)` (null on first run).
2. If both `old` is null/empty AND `reportText` is trivially empty (no commits/tasks/blockers
   for the period) → **skip** (don't create an empty brief; don't burn a model call). Returns
   without writing.
3. One `openai.chat.completions.create({ model: MODELS.fast, messages: [merge prompts] })`.
4. `next = truncate(completion…content.trim(), MAX_BRIEF_CHARS)`. If empty → skip write.
5. `set(briefRef, { content: next, updatedAt: serverTimestamp(), version: (old?.version ?? 0) + 1 })`
   (full `set`, not merge — the three fields are the whole doc).
6. Any throw at steps 3–5 → `logger.warn`, return (report already persisted; never rethrow).

**Caller wiring (`summarizeDayFlow`, new Step 4 after line 212):**

```ts
// ---- Step 4: roll the project brief (best-effort; never fails the report) ----
try {
  await mergeProjectBrief(repoId, renderReportForBrief(result));
} catch (err) {
  logger.warn('summarizeDayFlow: projectBrief merge failed (best-effort)', {
    repoId, docId, err: String(err),
  });
}
```

`renderReportForBrief(result)` = a small deterministic stringifier of
`{ summary, highlights, blockers, commitThemes }` (NOT memberContributions — counts are
noise for long-term memory). Defined in `tools/projectBrief.ts` and unit-tested.

> **Range vs single-day:** `summarizeDayFlow` runs both for the 18:00 cron (single day) and
> the manual Regenerate (possibly a multi-day range). Both legitimately roll the brief — a
> manual regenerate of a wide range is a *richer* merge input, which is fine. No gating on
> range. (Concurrency/version race covered in Risks + Q3.)

### Brief-merge prompt design (anti-bloat)

`projectBriefMergeSystem` (the hard-part material — "how rolling summary doesn't grow
unbounded"):

```
You maintain a SINGLE living "project brief" for one software repo: the durable knowledge a
new teammate (or an AI agent) needs to act well on this project. You are given the CURRENT
brief and the LATEST daily report. Produce the UPDATED brief.

KEEP (these are the brief's whole purpose):
- Architecture decisions and the reasoning behind them.
- Conventions / patterns the team follows (naming, testing, branch flow, idempotency rules…).
- Recurring or unresolved blockers, and known sharp edges / gotchas.
- Stable tech choices (frameworks, services, model tiers).

EVICT (actively remove — the brief is not a changelog):
- Day-specific activity ("today we merged 3 PRs") — that lives in daily reports, not here.
- Anything the latest report shows is now resolved, reverted, or obsolete.
- Duplicates and near-duplicates — merge them into one crisp statement.

HARD RULES:
- Output ONLY the brief markdown. No preamble, no "here is the updated brief".
- ABSOLUTE MAXIMUM 500 words. If you would exceed it, drop the least-durable, oldest, or
  most-specific lines until you fit. Brevity beats completeness.
- Do NOT invent facts. Every line must be grounded in the current brief or the latest report.
  When unsure whether something is durable, leave it OUT.
- If the latest report adds nothing durable, return the current brief essentially unchanged.
- Prefer terse bullet points grouped under short headings.
```

`projectBriefMergeUser({ oldBrief, report })`:

```
CURRENT PROJECT BRIEF (empty if this is the first report):
<oldBrief or "(none yet)">

LATEST DAILY REPORT:
<report>

Return the updated project brief.
```

Anti-bloat is **three independent guards**: (1) prompt eviction instructions, (2) the 500-word
cap in the prompt, (3) the deterministic `MAX_BRIEF_CHARS` truncation in code. The demo
"hard part" talking point is exactly this layering.

### Read points (cache-aware placement)

Each flow prepends `formatBriefForPrompt(brief)` as the FIRST thing in its stable
system/context content, ahead of variable per-request content, so the OpenAI prompt-cache
prefix is preserved across requests on the same repo+day.

| Flow | Where | Placement |
|---|---|---|
| `breakdownTaskFlow` | Step 1 `projectContext` (`breakdownTask.ts:59–68`) | Brief block at the **top** of `projectContext`, before the repoDocs block and repo name. (`goal` is the variable suffix; system prompt is already constant.) |
| `assignTaskFlow` | `buildTaskBrief` user message (`assignTask.ts:287`) OR a prefix appended to `assignTaskSystem` | **Proposal:** prepend the brief block to the **user** message produced by `buildTaskBrief`, above `repoId/taskId/...`. The system prompt stays byte-identical (best cache). The task fields are the variable suffix. |
| `generateHandoffFlow` | the `user` content from `generateHandoffContext(...)` (`generateHandoff.ts:174–187`) | Prepend the brief block to the assembled user content (system prompt unchanged). |
| `dailyBriefChatFlow` | the `system` message (`dailyBriefChat.ts:105`) | Append the brief block to `dailyBriefSystem(date,endDate)` so it sits before history + question. (System is the stable prefix; question is variable.) |

In every case: empty brief → `''` → **byte-identical** to today's prompt (zero behavior change,
zero cache invalidation). All four reads are best-effort (`readProjectBrief` never throws).

---

## W3b — expertiseTags learning

### Tool-schema change (`flows/assignTask.ts` TOOLS, `finalizeAssignment`)

Add an optional property; keep `required: ['assigneeId', 'reason']` (tags optional so the
agent is never forced to fabricate them):

```ts
learnedTags: {
  type: 'array',
  items: { type: 'string' },
  description:
    "0-4 short lowercase skill tags (e.g. 'frontend','auth','ml') that the EVIDENCE YOU " +
    "ACTUALLY RETRIEVED shows this assignee has. Derive ONLY from commits/among tools you " +
    "called this run — do NOT guess from the task title. Omit or [] if you have no evidence.",
},
```

`prompts/assignTask.ts` adds one rule: *"When you finalize, you MAY include `learnedTags`:
1–4 short lowercase skill tags justified by commit evidence you retrieved this run. Never
invent tags from the task description alone; omit them if you did not search a member's
commits."*

### Finalize-branch wiring (`flows/assignTask.ts`, after `applyAssignment`, ~line 205)

```ts
const learnedTags = normalizeTags(args.learnedTags); // string[] → trimmed, lowercased, deduped, ≤? 
await applyAssignment(repoId, taskId, assigneeId);
if (learnedTags.length > 0) {
  await mergeLearnedTags(repoId, assigneeId, learnedTags); // best-effort, never throws
}
return { assigneeId, reasoning: reason };
```

`mergeLearnedTags(repoId, userId, tags)` (proposed home: `tools/assignTools.ts`):

```ts
// Best-effort. Merges tags into users/{userId}.expertiseTags, capped at MAX_TAGS=8.
// NEVER throws — a write failure is logged and swallowed (the assignment already applied).
async function mergeLearnedTags(repoId, userId, newTags: string[]): Promise<void>
```

### Tag-cap algorithm (deterministic, cap = 8)

`arrayUnion` alone cannot enforce a cap, so we **read-merge-write** (no transaction needed —
best-effort, last-writer-wins is acceptable for a learning signal):

```
mergeLearnedTags(repoId, userId, newTags):
  clean = dedupe(newTags.map(t => t.trim().toLowerCase()).filter(0 < len ≤ 30))
  if clean is empty: return
  snap = get(users/{userId})            // tolerate missing doc
  existing = (snap.expertiseTags as string[]) ?? []
  // Deterministic eviction: keep order existing-first, append only NEW tags not already present;
  // if the result exceeds MAX_TAGS=8, DROP FROM THE FRONT (oldest) until length == 8.
  merged = [...existing]
  for t in clean: if t not in merged: merged.push(t)
  if merged.length > MAX_TAGS: merged = merged.slice(merged.length - MAX_TAGS)  // keep newest 8
  set(users/{userId}, { expertiseTags: merged }, { merge: true })   // NOT update — doc may be absent
```

Eviction policy: **oldest-first** (`slice(len-8)` keeps the 8 most-recently-relevant tags).
This is deterministic and matches the plan's "drop oldest/excess deterministically". We do
**not** use raw `arrayUnion` because it cannot bound length; the plan's "arrayUnion" intent is
satisfied by the in-code set-union (`if t not in merged`), with an explicit cap on top.

> **Why `set(merge:true)` not `update()`:** the `users/{userId}` doc is NOT guaranteed to exist
> for every member (`readTeamState` tolerates its absence). `update()` would throw NOT_FOUND;
> `set(...,{merge:true})` creates-or-updates only the `expertiseTags` field, leaving any other
> identity fields intact.

### Read-back confirmation

`readTeamState` (`assignTools.ts:47`) reads `expertiseTags` from `users/{userId}`. Because
W3b writes to that exact field, the **next** `assignTaskFlow` run that calls `readTeamState`
surfaces the learned tags to the agent (and the assign prompt already says "prefer members
whose expertiseTags … match"). Loop closed; documented. The 1-line demo: "each assignment
teaches the system a little more about each person."

---

## Test plan (jest, boundary-mock — `testing-guidelines.md`)

### NEW `__tests__/projectBrief.test.ts`
- `readProjectBrief`: missing doc → `null`; present doc → typed object; `db.get` throws →
  `null` (best-effort, no throw).
- `formatBriefForPrompt`: `null` → `''`; non-empty → contains the stable label + content.
- `mergeProjectBrief`: **first run** (no old, non-empty report) → one OpenAI call, writes
  `version:1`, content truncated to ≤ MAX_BRIEF_CHARS; **subsequent run** → `version` = old+1;
  **empty old + empty report** → **no OpenAI call, no write** (skip guard); **OpenAI throws**
  → no write, no rethrow (logger.warn); **over-long model output** → written content length
  ≤ MAX_BRIEF_CHARS and ends with the truncation marker.
- `renderReportForBrief`: includes summary/highlights/blockers/themes, excludes member counts.
- `mergeLearnedTags` (wherever it lands): cap enforced (existing 7 + 3 new → 8, oldest dropped);
  dedupe + lowercase; missing users doc → `set(merge:true)` still writes; write throws → no throw.

### CHANGE `__tests__/summarizeDay.test.ts`
- Existing 250-test baseline must stay green. The flow now makes an EXTRA OpenAI call after
  the report, so the scripted `createQueue` for each summarize test needs **one more** finalize
  turn (a brief-merge completion returning markdown) — OR mock `tools/projectBrief` so
  `mergeProjectBrief` is a no-op in the report tests and assert it was called once. **Proposal:
  `jest.mock('../tools/projectBrief')`** in summarizeDay.test.ts so existing report assertions
  are untouched and we add one test asserting `mergeProjectBrief` is invoked with the report.
  (Avoids reworking every scripted OpenAI queue.)
- New: a dedicated test that does NOT mock projectBrief, scripts the merge completion, and
  asserts `meta/projectBrief` was written with `version` incremented.

### CHANGE `__tests__/assignTask.test.ts`
- Existing finalize tests stay green (`learnedTags` optional → omitted = no tags write).
- New: finalize with `learnedTags:['auth','ml']` → assert `users/{assigneeId}.expertiseTags`
  contains them after the run; cap test (seed 7 existing → +2 new → length 8, oldest dropped).
- New: write-back is best-effort — make the tags `set` throw → assignment result still returned.
- **Mock extension needed:** the current `assignTask.test.ts` fake `doc()` exposes only `get()`
  (no `set`), and `FieldValue` has no `arrayUnion`. Add `set(data, options)` to the fake `doc`
  and (only if we use `arrayUnion`) an `arrayUnion` sentinel — but the chosen read-merge-write
  algorithm uses a plain `set(merge:true)` with a computed array, so **no `arrayUnion` sentinel
  is required**; just add `doc().set`.

### Gates
`npm --prefix functions run typecheck` + `lint` + `test` all green; suites/tests count rises
from the new files (expect ~34 suites, +~12 tests). Re-confirm 0 typecheck errors.

---

## Out of scope

- W5 `askRepo` brief prefix (flow doesn't exist yet; W5 wires it).
- Any UI to view/edit the brief or tags (demo reads Firestore directly / via existing roster UI).
- Embedding/vectorizing the brief; brief is plain markdown injected as text.
- A manual "regenerate brief" callable or a `force` flag (the daily flow + manual regenerate
  already drive it).
- Per-member brief, per-task memory, or decay/aging of tags beyond the size cap.
- Tag taxonomy validation / canonicalization beyond trim+lowercase+dedupe.
- Token encryption / KMS, ML expertise modelling beyond tag accumulation (post-demo).

## Risks

- **Brief drift / hallucination.** A bad merge could inject a false "convention". Mitigations:
  the prompt forbids invented facts and says "when unsure, leave it out"; the merge is grounded
  in (old brief + that day's real report) only; cap limits blast radius; it is advisory context,
  never an authoritative action input. Demo can eyeball the brief.
- **Unbounded growth.** Addressed by the 3-guard anti-bloat design (prompt eviction + 500-word
  prompt cap + deterministic `MAX_BRIEF_CHARS` truncation). The truncation is the backstop that
  doesn't trust the model.
- **Prompt-cache invalidation.** A brief that changes daily shifts the cached prefix once/day —
  acceptable. The risk is putting the brief in a *variable* position (mid-message) which would
  break caching every request; the design pins it to the **stable prefix** in every flow, and
  empty brief = byte-identical prompt.
- **Concurrent summarize calls racing the brief `version`.** Two `summarizeDayFlow` runs for the
  same repo (e.g. cron + a manual regenerate overlapping) both read `old.version` then write —
  last writer wins, a version number can be reused/skipped, one merge's content can be lost.
  Acceptable for a best-effort advisory brief (not a correctness invariant); `version` is a
  display/debug counter, not a lock. If we want stronger ordering, a `runTransaction`
  read-then-set on the brief doc is a cheap upgrade — **flagged as Q3, not in scope unless Fable
  5 wants it.**
- **Extra cost/latency on every daily report.** One additional `MODELS.fast` call per report.
  Negligible vs. the report's own agentic loop; skipped entirely when there's nothing to merge.
- **Tag pollution from a hallucinated `learnedTags`.** Mitigated by the prompt ("only from
  evidence you retrieved"), optional schema, dedupe+lowercase, and the cap-8 with oldest-first
  eviction so noise ages out.
- **Wrong write target (the schema discrepancy).** If we followed the plan literally and wrote
  `members/{userId}.expertiseTags`, `readTeamState` would never read it back — silent no-op loop.
  Mitigated by writing to `users/{userId}` (see discrepancy #1). **Highest-value correction.**

## Open questions — RESOLVED (orchestrator rulings, 2026-06-12)

- **Q1 — Write target. RESOLVED: CONFIRMED.** Write to `apps/gitsync/users/{userId}.expertiseTags`
  via `set({ expertiseTags: merged }, { merge: true })`. This discovery corrected the plan
  (`FINAL_DEMO_PLAN.md` §W3b's `members/{userId}` is wrong against the real schema —
  `readTeamState` reads `expertiseTags` from the **users** doc). `set(merge:true)` (not `update()`)
  because the users doc may not pre-exist for a member. Implemented in
  `tools/assignTools.ts::mergeLearnedTags`.
- **Q2 — `MAX_BRIEF_CHARS`. RESOLVED: 3500.** Deterministic truncation to 3500 chars with a `…`
  marker, independent of the 500-word prompt instruction.
- **Q3 — Brief version race. RESOLVED: best-effort last-writer-wins, NO transaction.** Concurrent
  summarize on one repo is rare; a lost merge self-heals on the next day's run. `version` is a
  display/debug counter, not a lock.
- **Q4 — Home of `mergeLearnedTags`. RESOLVED: `tools/assignTools.ts`** (next to `readTeamState`,
  which reads the same field). `tools/projectBrief.ts` stays W3a-only.
- **Q5 — summarizeDay test strategy. RESOLVED: `jest.mock('../tools/projectBrief')`** in
  `summarizeDay.test.ts` (existing report assertions untouched; assert `mergeProjectBrief` is
  invoked with the rendered report + best-effort isolation). A dedicated NEW
  `__tests__/projectBrief.test.ts` covers the brief logic itself (merge call, version increment,
  3500 truncation, skip guard, failure isolation).
- **Q6 — `breakdownTaskFlow` AND `dailyBriefChat` get the brief. RESOLVED: CONFIRMED both.**
  `dailyBriefChat` stands in for W5's `askRepo` (which will inherit the same pattern).
