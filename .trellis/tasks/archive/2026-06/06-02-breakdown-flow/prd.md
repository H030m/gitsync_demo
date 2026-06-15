# Complete breakdownTask AI flow (Step 1-6) + fix add_todo button

## Goal

Make the "Break down with AI" feature work **end-to-end live** for the team's
real onboarding scenario: a user **imports a new project and pastes its
`SPEC.md`** into the text box; the backend `breakdownTaskFlow` feeds that spec
(plus light repo info) to OpenAI (structured output), generates a **shallow**
TODO list + dependency graph, persists them as real Firestore task docs, and
returns them to the app for review. Today the flow body is a stub
(`throw new Error('breakdownTaskFlow not implemented yet')`) and the app's
"Break down with AI" button can't be pressed.

### Scenario (from user, 2026-06-02)

* Input = a whole **`SPEC.md`** pasted into the box (not a one-line goal).
* New project → little/no existing tasks or commit history to mine.
* First pass generates only a **few layers** of the dependency graph (high-level
  TODOs); deeper decomposition is added later as work progresses → out of scope now.
* Context = **mainly the pasted markdown**; repo info (name/desc) is a light
  supplement, not the GitHub commit history.

## What I already know (from repo inspection)

Backend scaffold is ~80% done — only the flow body is missing:

* `functions/src/handlers/breakdownTask.ts` — ✅ `onCall`, auth guard, input
  validation, **owns the distributed lock** (`isBreakingDown` set true in a txn,
  released in `finally`). Returns `breakdownTaskFlow(...)` directly.
* `functions/src/flows/breakdownTask.ts` — ❌ body is a stub. BUT
  `detectCycles()` (DFS) is already implemented + the helper re-exports are set.
* `functions/src/prompts/breakdownTask.ts` — ✅ `breakdownTaskSystem` +
  `breakdownTaskUser({projectContext, goal})`.
* `functions/src/types.ts` — ✅ `BreakdownOutputSchema` (zod). LLM `dependsOn`
  is `number[]` (0-based indices); backend translates → `string[]` taskIds.
* `functions/src/config.ts` — ✅ `getOpenAI()`, `MODELS` (reasoning=gpt-4o,
  fast=gpt-4o-mini), `openaiKey` secret. `openai`+`zod` deps installed.
* Frontend: `functions_service.dart` LIVE `breakdownTask` callable wired ✅;
  `SubTask` model ✅; `FakeFunctionsService` returns canned subtasks ✅.
* `OPENAI_API_KEY` secret now provisioned in Secret Manager (user just set it).

### Design contract (ARCHITECTURE §5.1)

Steps 1-6: fetchProjectContext → openai parse → detectCycles (→ re-prompt on
cycle) → pre-generate Firestore taskIds → translate dependsOn index→taskId →
transactional batch write to `apps/gitsync/repos/{repoId}/tasks/{taskId}`.

**Correction vs the doc:** §5.1 Step 6 says the flow also unlocks
`isBreakingDown`. It must NOT — the *handler* already owns that lock and releases
it in `finally`. The flow only writes task docs.

Task doc shape (mirror `lib/models/task.dart`): `{ title, description, status:
'todo', dependsOn: string[], estimatedHours, source: 'ai_breakdown', createdBy:
requestedBy, parentTaskId: null, createdAt, updatedAt }`.

## The add_todo button bug

`lib/views/tasks/add_todo_page.dart:67` — `onChanged: (v) => _goal = v` updates
the field WITHOUT `setState`, so the button's `onPressed` disabled-condition
(`_goal.trim().isEmpty`, line 71) never re-evaluates → button stays disabled
forever. Fix: `onChanged: (v) => setState(() => _goal = v)`.

## Decisions (resolved 2026-06-02)

* **Context scope** → pasted SPEC.md + light repo info (name/desc). No GitHub
  commit history.
* **Input UX** → relabel `AddTodoPage` field to "Project spec (paste SPEC.md)",
  enlarge to a tall scrollable box, hint mentions markdown. Backend wiring
  unchanged (`breakdownTask(goal: specText)`).
* **Granularity** → shallow: prompt instructs ~5-12 high-level top-level TODOs,
  dependencies only among those top-level tasks, no recursive sub-decomposition.
* **Cycle handling** → on cycle, re-prompt the LLM once with the cycle info
  (§5.1 Step 3b); if it still cycles, throw `HttpsError('internal', ...)`.

## Requirements

* Implement `breakdownTaskFlow` Steps 1-6 end-to-end:
  * Step 1 `fetchProjectContext`: read `repos/{repoId}` (name/desc) + note "new
    project, no existing tasks"; the pasted SPEC.md is the `goal` arg. NO GitHub.
  * Step 2: `openai.chat.completions.parse` + `zodResponseFormat(BreakdownOutputSchema)`,
    model `MODELS.reasoning`. Prompt augmented to cap at ~5-12 shallow top-level tasks.
  * Step 3/3b: `detectCycles` → on cycle, re-prompt once with cycle info; still
    cyclic → `HttpsError('internal')`.
  * Step 4: pre-generate Firestore taskIds (`tasksCol.doc().id`).
  * Step 5: translate `dependsOn` index→taskId.
  * Step 6: transactional batch write to `repos/{repoId}/tasks/{taskId}`
    (`source: 'ai_breakdown'`, `status: 'todo'`, `createdBy: requestedBy`).
    **Does NOT touch `isBreakingDown` — handler owns the lock.**
* Update prompt (`prompts/breakdownTask.ts`) to enforce the shallow-graph rule.
* Fix the `add_todo_page` setState button bug + relabel/enlarge the input box.
* Backend unit tests (boundary-mock OpenAI + Firestore): happy path, dependsOn
  index→taskId translation, cycle → re-prompt path. `detectCycles` direct tests.
* Deploy `breakdownTask` + set its Cloud Run service to public (allUsers
  run.invoker), same as addRepo. Live end-to-end verification.

## Acceptance Criteria (evolving)

* [ ] Typing a goal enables "Break down with AI"; pressing it returns subtasks.
* [ ] Subtasks are written under `repos/{repoId}/tasks/{taskId}` with
      `source: 'ai_breakdown'` and `dependsOn` as real taskIds.
* [ ] Cycles in LLM output are handled (no cyclic deps persisted).
* [ ] `isBreakingDown` lock is released after success AND after failure.
* [ ] Backend tests + lint + typecheck green; `flutter analyze`/`test` green.

## Definition of Done

* Tests added/updated (backend jest boundary-mock; frontend if VM logic added).
* Lint / typecheck / analyze green.
* Docs/spec notes updated if behavior changes.
* Deployed + live-verified; Cloud Run public-access step documented.

## Out of Scope (explicit)

* `assignTaskFlow`, `generateHandoffFlow`, `summarizeDayFlow` (other D-module flows).
* GitHub Issue creation for each subtask (separate feature).
* Discard-on-cancel UX (subtasks are persisted at breakdown time, not on confirm).
* README / vector-context retrieval beyond the chosen Q1 scope.

## Technical Notes

* Region pinned `asia-east1` (must match `functions/src/admin.ts::REGION`).
* OpenAI structured output: `openai.chat.completions.parse` +
  `zodResponseFormat(BreakdownOutputSchema)` (helper already re-exported).
* GitHub token (if Q1=with-commits) lives at
  `apps/gitsync/users/{uid}.githubAccessToken`; repo owner/repo derivable from
  repoId (`${owner}_${repo}`) or the repo doc.
