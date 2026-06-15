# Database Guidelines (Firestore)

> No ORM, no migrations. Database is **Cloud Firestore** accessed via firebase-admin
> on the backend and `cloud_firestore` on the frontend.
> Schema source of truth: [`docs/ARCHITECTURE.md §2`](../../../docs/ARCHITECTURE.md).

---

## Path convention (non-negotiable)

**Every collection lives under `apps/gitsync/`.** Never write to root `users/` or `repos/`.
This mirrors the course `group-todo-list` example (see [`MEMORY.md 2026-05-20`](../../../docs/MEMORY.md)).

```
apps/gitsync/users/{userId}
apps/gitsync/repos/{repoId}
apps/gitsync/repos/{repoId}/{tasks|commits|pullRequests|discordMessages|dailyReports|members}/{id}
apps/gitsync/idempotencyKeys/{eventId}
```

Backend builds the literal path from `repoId` params. The frontend mirror is
`lib/repositories/firestore_paths.dart`. See `ARCHITECTURE.md §2.1` for the full
field-by-field schema of every collection.

---

## Who may write what (mirror the security rules)

`firestore.rules` enforces this; schema design depends on it ([`ARCHITECTURE.md §2.2`](../../../docs/ARCHITECTURE.md)):

- `commits` / `pullRequests` / `discordMessages` / `dailyReports` → `allow write: if false`.
  **Only Cloud Functions (admin SDK) write these.** The Flutter app only reads them.
- `tasks` / `users` / repo root → the app writes (rules check membership / ownership).
- Never invent a new collection or field without proposing it in `docs/MEMORY.md` first.

> **Membership model**: `members/{uid}` is keyed by **Firebase Auth uid** and is
> **client-write-blocked** — only Cloud Functions write it. A person becomes a member by
> (a) **self-join** (`addRepo` adds the caller when they connect a repo) or (b)
> `importCollaborators` (pulls the repo's GitHub collaborators and adds those who **already have a
> GitSync account** — `users.githubLogin == login`). Collaborators who've never signed in have no
> uid, so they can't be members/assignees (returned as `pending`). Assigning a task to someone
> therefore requires them to have signed in at least once.

---

## Concurrency rules (triggers & webhooks run concurrently)

From [`ARCHITECTURE.md §4.4`](../../../docs/ARCHITECTURE.md) — violating these corrupts counters/state:

- **Rule A — counters use atomic ops.** Any numeric field (`activeIssueCount`,
  `completedTaskCount`) must use `FieldValue.increment(±1)`. Never read-then-write.
- **Rule B — cross-field/cross-doc changes use `runTransaction`.** Read inside the
  transaction to guard idempotency (e.g. "task not already done"), then update.
- **Rule C — every Firestore trigger does an idempotency check.** Triggers are
  at-least-once. Use `markIdempotent(event.id)` from `tools/idempotency.ts`:
  ```ts
  const fresh = await markIdempotent(event.id);
  if (!fresh) return; // already processed
  ```
- **Rule D — never put slow side-effects in the idempotency transaction.** Mark the key,
  *exit* the transaction, *then* call OpenAI / GitHub, then write results back. MVP accepts
  an occasional null `aiSummary`/`embedding` on failure + a manual "regenerate" button.
  - **Rule D.1 — one trigger per doc path; fold related concerns in, don't add a second
    trigger.** `markIdempotent(event.id)` keys on `event.id`, which is the SAME for every
    function bound to the same document write. So a *second* trigger on the same path (e.g. a
    new `onTaskAssigneeChanged` alongside `onTaskUpdated`) would call `markIdempotent` with an
    id the first trigger already consumed → it silently returns `!fresh` and never runs. Put
    the new concern inside the existing trigger instead. Concrete (06-06): assignee→GitHub-issue
    sync lives at the TOP of `onTaskUpdated` (before the `status==='done'` transition guard), so
    it runs on every task update — manual reassignment AND `assignTaskFlow`'s downstream
    auto-assign — while the done-only downstream logic stays gated below. Each folded-in concern
    gets its own `try/catch` so one failing on a given event never aborts the others.
    - **D.1 exception — two triggers on the same path are safe ONLY IF the second consumes its
      idempotency key on a write the first never observes — and that requires guard-before-mark
      ordering.** `event.id` is shared across *all* functions bound to the **same** write; only
      *distinct* writes get distinct ids. Concrete (06-14): `commits/{sha}` has both
      `onCommitCreated` (`onDocumentCreated`, fires on the first-seen **create**, usually a
      feature-branch push) and `onCommitCompletesTask` (`onDocumentWritten`, meant to run only on
      the `onDefaultBranch` flag flipping `false→true`). The flag is set by a **dedicated**
      `set({onDefaultBranch:true},{merge:true})` write in `handlePush`, *separate* from the
      `.create()`.
      - **The trap:** the feature-branch `.create()` is a SINGLE write, so it fires BOTH triggers
        with the **same `event.id`**. If `onCommitCompletesTask` called `markIdempotent(event.id)`
        *before* its transition guard, whichever trigger won the race would burn the shared key —
        starving `onCommitCreated` of its linking/embedding run (silent `linkedTaskIds`/`aiSummary`
        loss). They do NOT "never share an id"; they share one on every create.
      - **The fix (load-bearing):** put the in-memory transition guard
        (`!after` / `after.onDefaultBranch!==true` / `before?.onDefaultBranch===true`) **ahead of**
        `markIdempotent`. Then `onCommitCompletesTask` returns early on the create (consuming
        nothing) and only marks the key on the dedicated default-branch `set(merge)` write, which
        `onCommitCreated` never observes. **General rule: when a second trigger shares a doc path,
        its cheap in-memory guard MUST precede `markIdempotent` so it never consumes a key on a
        write meant for the other trigger.**
      - Why not just fold it into `onCommitCreated` (per D.1)? A merge re-push hits `ALREADY_EXISTS`
        on `.create()`, so `onCommitCreated` never re-fires for the default-branch arrival — the
        auto-complete concern genuinely needs its own trigger on a separate write (Rule E pattern).
- **Rule E — match the trigger type to how the source doc is written.** If the producing
  write **creates** the doc already in its terminal state, `onDocumentUpdated` will **never
  fire** (it only fires on updates to an existing doc). The webhook's `handlePR` writes
  `pullRequests/{n}` directly as `state: 'merged'` (a create), so `onPRMerged` must be
  `onDocumentWritten`, guarding on the *transition into* the state:
  ```ts
  // onDocumentWritten — fires on create AND update
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!after) return;                                   // deletion → ignore
  if (after.state !== 'merged' || before?.state === 'merged') return; // transition guard
  ```
  Reserve `onDocumentUpdated` for docs that genuinely change *after* creation (e.g. a
  `tasks` doc edited by the app). The in-txn idempotent re-read still guards double-fires.
  Unit tests that call the raw handler with a synthetic `before/after` will pass either way —
  this gap only shows up live, so pick the trigger type deliberately.

---

## Vector search (Firestore native `findNearest`)

- Embeddings stored as `FieldValue.vector(...)`, dimension `1536` (`EMBEDDING_DIM` in
  `config.ts`, model `text-embedding-3-small`).
- A `findNearest` query **must** carry `.where('repoId', '==', repoId)` to avoid cross-repo
  leakage — that's why `commits`/`discordMessages`/`pullRequests` redundantly store `repoId`.
- Required vector + composite indexes live in `firestore.indexes.json`.
  **Creating/deploying indexes is the user's job** (`firebase deploy --only firestore:indexes`),
  never the AI's — see `AI_AGENT_RULES.md §R2`.
- Before embedding a commit, call `shouldSkipEmbedding(message)` (`tools/commitFilter.ts`) to
  skip noise (`Merge ...`, version bumps, etc.).

---

## Rule F — producer must persist the field name the consumer prefilters on

When a doc is written by one function (producer) and a `findNearest` / `where` prefilter in
another (consumer) reads it, the **stored field name is a contract** — a mismatch fails
*silently* (query returns `[]`, no error). The schema in `ARCHITECTURE.md §2.1` is the single
source of truth for the key; the inbound payload's key is irrelevant and often differs.

Concrete incident (2026-06): GitHub's `push` webhook payload delivers the author handle as
`commits[].author.username`, but the canonical schema is `commits.author.login` and
`searchMemberCommits` prefilters `.where('author.login','==',githubLogin)`. `handlePush` had
persisted it under `author.username`, so the vector search always returned nothing. Fix: map
on write (`login: payload.author.username`), not on read.

Before writing a doc that something else queries: open `ARCHITECTURE.md §2.1`, copy the exact
field name, and (if the payload key differs) translate at the write site. Unit tests that mock
the consumer's Firestore won't catch this — trace the **actual producer** (as in Rule E).

---

## Rule G — prefer single `array-contains` + in-code filter over a composite index

A query like `where('dependsOn','array-contains', id).where('status','==','todo')` needs a
**manually-created composite index** — and if it's missing the trigger *crashes at runtime*
(`FAILED_PRECONDITION`), not at deploy. Since index creation is the user's job
(`AI_AGENT_RULES §R2`), that's a live-only landmine.

When the second predicate is cheap and low-cardinality (a status enum, a boolean), run the
**single** `array-contains` query (auto-indexed, zero setup) and filter the rest in code. The
result set here is "tasks depending on X" — always small — so the in-memory filter is free.
`onTaskUpdated`'s downstream/ready check does exactly this. Reserve composite indexes for
queries whose prefilter genuinely must run server-side for scale (and then add the index to
`firestore.indexes.json` + flag the deploy command for the user).

---

## Deleting a repo (aggregate root) + its subcollections

Deleting a doc does **not** delete its subcollections — they orphan. To remove a `repos/{repoId}`
and everything under it (`members/tasks/commits/pullRequests/discordMessages/dailyReports`), use
the admin SDK's `db.recursiveDelete(repoRef)` (single call, handles all subcollections).

**Order matters** — delete cross-collection pointers (e.g. each member's
`users/{memberUid}/repos/{repoId}`, which live under `users/`, NOT under the repo) *before*
`recursiveDelete`:

```ts
await Promise.all(memberIds.map((m) =>
  db.doc(`apps/gitsync/users/${m}/repos/${repoId}`).delete()));
await db.recursiveDelete(db.doc(`apps/gitsync/repos/${repoId}`));
```

Pointers-first means a failure leaves the repo doc intact, so a retry is well-defined (and a
later read still returns the repo → no spurious `not-found`). The reverse order would orphan the
pointers permanently. Pair external cleanup (e.g. best-effort `deleteWebhook`) with this — see
`handlers/removeRepo.ts` and the best-effort pattern in [`error-handling.md`](./error-handling.md).

---

## Timestamps

- Server-authored times use `FieldValue.serverTimestamp()` on write (`createdAt`, `updatedAt`,
  `processedAt`). Don't persist client clock values for these.
- Event times parsed from external payloads (e.g. a webhook's ISO-8601 `timestamp`) MUST be
  converted to a Firestore `Timestamp` before writing — never store the raw string. See the
  type-strict query rule below for why.

---

## Rule H — Firestore queries are TYPE-STRICT (a schema bug needs a data migration, not just a writer fix)

**What**: A `where()` comparison only matches docs whose field holds the **same type** as the
operand. Comparing against a `Timestamp` silently excludes docs where the field is a string —
no error, no warning, just zero matches. `orderBy()`-only queries still return those docs
(Firestore sorts mixed types in type order), which hides the corruption.

**Symptom profile** (recognize it fast): *"the default/unfiltered list works, but every
filtered/range view is empty"* — and switching the filter back doesn't help. That smell means a
type mismatch between the stored field and the query operand, not a missing index (a missing
index throws; a type mismatch doesn't).

**Why it bit us** (06-04 task): the old `githubWebhook` wrote `committedAt` as the payload's
ISO string. Fixing the webhook (7144b4b) fixed *new* docs only — all 37 existing commit docs
still silently fell out of every Timestamp range query (Flutter `streamRange`, dailyIntel
`listRangeCommits`), so the Commits tab range filter returned nothing.

**The complete fix is always two-sided**:

1. **Writer**: parse + convert at the ingest boundary
   (`Timestamp.fromDate(new Date(payload.timestamp))`, fall back to `serverTimestamp()`).
2. **Data**: migrate existing docs with an idempotent, `--dry-run`-gated script — pattern:
   `functions/scripts/normalize-commits.mjs` (scan → report would-fix count → real run →
   re-run dry-run must report 0).

```ts
// Wrong — "fixed the webhook, done": old docs still invisible to range queries
batch.set(ref, { committedAt: payload.timestamp });        // string

// Correct — uniform type on write + one-off migration for what's already stored
const parsed = payload.timestamp ? new Date(payload.timestamp) : null;
const committedAt = parsed && !Number.isNaN(parsed.getTime())
  ? Timestamp.fromDate(parsed)
  : FieldValue.serverTimestamp();
```

**Tests required**: the webhook unit test asserts the stored field is a real `Timestamp`
parsed from the payload ISO string AND the server-time fallback when absent
(`__tests__/githubWebhook.test.ts`); reader models tolerate the legacy shape defensively
(`Commit._parseTimestamp`) so a stray doc degrades instead of hanging a stream.

---

## Localizing outbound push (FCM) per recipient

Push **titles** are localized to the *recipient's* language, not the actor's or a fixed
default. The language is read from the recipient's user doc — `users/{uid}.locale`
(`'en' | 'zhHant'`, written by the client in `services/locale_notifier.dart` on sign-in and on
every Settings language change via `UserRepository.updateLocale`, a `set(merge)` so it never
races the sign-in upsert). `notifyAssignee` already fetches the user doc for `fcmToken`, so it
reads `locale` from the **same snapshot** (no extra read) and defaults to `zhHant` for
missing/unknown values (`notifyLocaleFromPref`).

- **Only titles are localized.** The body is real data (the task title) and stays verbatim.
  Localized copy lives in `tools/i18n.ts` (`notifyMessages.*`, both languages side by side —
  the backend mirror of the client `app_strings.dart`).
- **Pass a builder, not a fixed string**, so resolution happens after the locale is known:
  `notifyAssignee(uid, (locale) => ({ title: notifyMessages.taskReadyTitle(locale), body }), data)`.
  `notifyAssignee` accepts either `{title,body}` or `(locale) => {title,body}`.
- **Tests required**: assert the sent `notification.title` switches with the seeded user
  `locale` — default (no `locale` field → zh) AND `locale:'en'` → English
  (`__tests__/onTaskUpdated.test.ts`).
