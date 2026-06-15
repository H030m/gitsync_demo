# Error Handling (Cloud Functions)

> All functions use `firebase-functions/v2`. Source: [`ARCHITECTURE.md §4`](../../../docs/ARCHITECTURE.md),
> [`COURSE_METHODS.md §6`](../../../docs/COURSE_METHODS.md).

---

## Callables (`onCall`) — throw typed `HttpsError`

Check auth and validate args at the top; surface failures as `HttpsError` so the Flutter
client receives a typed `FirebaseFunctionsException`.

```ts
import { onCall, HttpsError } from 'firebase-functions/v2/https';

export const breakdownTask = onCall(
  { region: REGION, secrets: [openaiKey], timeoutSeconds: 300 },
  async (request) => {
    if (!request.auth) throw new HttpsError('failed-precondition', 'Please log in first.');
    const { repoId, goal } = request.data as { repoId?: string; goal?: string };
    if (!repoId || !goal) throw new HttpsError('invalid-argument', 'repoId and goal are required');
    // ...
  },
);
```

Codes used in this repo: `failed-precondition` (not logged in), `invalid-argument`
(missing/bad input), `not-found` (missing doc), `already-exists` (lock held).

---

## Distributed lock — always release in `finally`

`breakdownTask` acquires `repos/{repoId}.isBreakingDown` in a transaction, then wraps the
flow in `try { ... } finally { ... }` and releases the lock even on error, swallowing the
unlock error so it never masks the real failure (`handlers/breakdownTask.ts`):

```ts
try {
  return await breakdownTaskFlow({ repoId, goal, requestedBy: request.auth.uid });
} finally {
  await repoRef.update({ isBreakingDown: false }).catch(() => {});
}
```

A crash before `finally` is recovered by the `scheduledUnstickBreakdown` trigger (>5 min stale).

**Handler owns the lock — the flow must not touch it.** The `onCall` *handler*
(`handlers/breakdownTask.ts`) is the sole owner of `isBreakingDown`: it acquires the lock in a
transaction and releases it in `finally`. The *flow* (`flows/breakdownTask.ts`) only does
business logic (fetch context → OpenAI → write task docs) and must **never** read or write
`isBreakingDown`. (ARCHITECTURE §5.1 Step 6 mentions the flow unlocking — that is superseded by
this division: if the flow also unlocked, an early flow `return` would release the lock before
the handler's `finally`, defeating the guard.) Same split applies to every future AI flow:
handler = guard/lock/auth, flow = pure work + writes.

---

## Webhooks (`onRequest`) — verify first, respond fast

1. Verify the signature/secret before anything else; on failure respond `401` (GitHub HMAC
   via `x-hub-signature-256`; `discordMessageIngest` checks the `x-ingest-secret` shared key).
2. Validate payload shape → `400` on missing fields.
3. Idempotency dedupe (`x-github-delivery` / Discord `messageId`) → respond `200 dup`.
4. Respond `200` within seconds (GitHub retries after ~10 s). Only normalize + write the raw
   doc here; push all heavy logic to the matching Firestore trigger. See `ARCHITECTURE.md §6.3`.

---

## Triggers — idempotency + Rule D

Triggers are at-least-once. Guard with `markIdempotent(event.id)` first; do slow OpenAI/GitHub
calls *after* the idempotency transaction commits (never inside it), then write results back.
On external-call failure, log and leave the enrichment field null (MVP) rather than re-throwing
in a way that loses the event.

---

## External API calls — always bounded

Every GitHub / OpenAI / Discord call must have a timeout; never wait forever
(`AI_AGENT_RULES.md §3.6`). For best-effort side-effects (e.g. `notifyDiscord`), swallow the
error with `.catch()` + a log — a failed notification must not fail the main write.

**Optional / secondary signal tools must be best-effort, never throw into the parent flow.**
When an agentic flow registers a *supporting* tool (one signal among several — e.g.
`searchMemberCommits` in `assignTaskFlow`, alongside workload / expertise / dependents), that
tool must `try/catch` its query and `return` an empty/neutral result on any failure, logging at
`warn`. A single optional signal must not be able to abort the whole flow. Concrete incident
(2026-06): `searchMemberCommits`'s vector `findNearest` threw `9 FAILED_PRECONDITION: Missing
vector index configuration` (index not yet deployed) and killed every downstream assignment —
`assigneeId` stayed null. Fix: wrap the `embed()` + `findNearest()` + result map in one
`try/catch → return []`, so assignment finalizes on the remaining signals. Corollary: a feature
must not hard-depend on a **user-deployed** Firestore index (indexes are the user's job per
`AI_AGENT_RULES §R2`) — degrade gracefully when it is absent. And match the index `queryScope`
to the query: a `.collection(...)` `findNearest` needs a `COLLECTION`-scoped index, NOT
`COLLECTION_GROUP` (see `database-guidelines.md`), or the deployed index silently won't match.

**Best-effort registration pattern** (`addRepo` webhook): when an external resource can't yet be
created end-to-end (dependency not ready / not deployed), wrap it in `try/catch`, log on failure,
and persist a null id so a later backfill can retry — never block the primary write. Generate and
store any secret *before* the try so it survives the failure path:

```ts
const secret = crypto.randomBytes(32).toString('hex'); // always persisted
let webhookId: number | null = null;
try {
  webhookId = await registerWebhook(owner, repo, token, { url, secret, events });
} catch (e) {
  logger.warn('webhook registration failed; continuing (backfill later)', { repoId, err: String(e) });
}
// ... write repo doc with { webhookId, webhookSecret: secret } in the batch
```

---

## AI flow shape: agentic vs single-completion (pick by caller)

Two flow shapes exist; pick by how the flow is invoked:

- **Agentic function-calling loop** (`assignTaskFlow`, `summarizeDay`, `dailyBriefChat`) — for
  user-initiated callables that benefit from the model drilling into data over several rounds.
- **Single-completion with pre-gathered context** (`explainCommit`, `discordDailyDigest`, and
  06-06 `generateHandoff`) — deterministically fetch all context, make ONE completion. **This is
  the required shape when the flow runs best-effort from a trigger** (e.g. `onTaskUpdated` calls
  `generateHandoffFlow`): bounded latency/cost, no multi-round loop that could stall the trigger,
  and easy to unit-test (seed Firestore + scripted OpenAI). Keep every context-gather in its own
  `try/catch → []/null` (commit query may need an undeployed composite index; Discord search and
  roster reads are optional signals) so the one OpenAI call still runs on partial context.

### Convention: `force` flag splits manual-regenerate from auto-cache

A flow that both (a) auto-runs from a trigger and (b) is exposed as a manual "regenerate" callable
takes a `force?: boolean`. The flow returns the cached field when `!force && existing`; the manual
**handler** passes `force: true` (always fresh), the **trigger** passes `force: false` (fill only
if absent, so re-firing on each newly-landed prerequisite doesn't redo work). Mirrors
`explainCommit`'s cache. The cache write-back is best-effort (Rule D) — log + return the markdown
even if the `update()` fails, so the caller still gets the result.

---

## Common mistakes

- Returning a plain object on error instead of throwing `HttpsError` (client can't distinguish).
- Adding a second Firestore trigger on a path another trigger already watches — the shared
  `event.id` makes `markIdempotent` swallow it (see database-guidelines Rule D.1); fold the concern
  into the existing trigger instead.
- Doing OpenAI work inside the idempotency transaction (Rule D) → lost data on retry.
- Forgetting the lock `finally` → repo stuck "breaking down".
- Heavy logic in the webhook handler → GitHub timeout + retry storm.
