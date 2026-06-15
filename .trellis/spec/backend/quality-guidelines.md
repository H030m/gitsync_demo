# Quality Guidelines (Cloud Functions)

> The binding rules of engagement are in [`docs/AI_AGENT_RULES.md`](../../../docs/AI_AGENT_RULES.md).
> This file is the backend-specific checklist.

---

## Required patterns

- `firebase-functions/v2` only — **never mix v1**.
- Region: `{ region: REGION }` from `admin.ts` (`'asia-east1'`) on every function.
- `onCall`: auth check (`if (!request.auth) throw HttpsError('failed-precondition', ...)`)
  then arg validation at the top.
- HTTP webhook: verify signature/secret first.
- Every Firestore trigger: `markIdempotent(event.id)` guard (`tools/idempotency.ts`).
- Counters via `FieldValue.increment`; cross-doc updates via `runTransaction` (see
  [`database-guidelines.md`](./database-guidelines.md) Rules A–D).
- External calls (OpenAI/GitHub/Discord) bounded by a timeout.
- AI flows use the OpenAI SDK with **structured outputs (zod)** — no Genkit
  ([`MEMORY.md 2026-05-20`](../../../docs/MEMORY.md)). See the SDK-path convention below.
- `index.ts` is re-exports only; one function per `handlers/` or `triggers/` file.

---

## Convention: OpenAI structured outputs (SDK path)

**What**: With `openai@4.x` (pinned `4.104.0`), the zod-parsing helper lives at
`openai.beta.chat.completions.parse(...)` — **not** the top-level
`openai.chat.completions.parse` shown in newer docs (that overload only exists in later
majors and does **not** typecheck here).

```ts
import { zodResponseFormat } from 'openai/helpers/zod';

const completion = await getOpenAI().beta.chat.completions.parse({
  model: MODELS.reasoning,
  messages: [ { role: 'system', content: sys }, { role: 'user', content: usr } ],
  response_format: zodResponseFormat(BreakdownOutputSchema, 'breakdown'),
});
const parsed = completion.choices[0].message.parsed;
if (!parsed) throw new HttpsError('internal', 'OpenAI returned no parsed output');
```

**Why**: a refusal/empty response makes `.parsed === null`; always guard it before use.
On an SDK major bump, re-check whether the top-level `.parse` path is now available.

---

## Forbidden

- `console.log` → use `logger` ([`logging-guidelines.md`](./logging-guidelines.md)).
- A second `initializeApp()` — import `db`/`REGION` from `admin.ts`.
- Hardcoding `'asia-east1'`, secrets, or model names inline — use `REGION` / `config.ts` `MODELS`.
- Heavy logic inside webhook handlers (push it to triggers).
- Slow side-effects inside the idempotency transaction (Rule D).
- New npm dependency without asking the user first (`AI_AGENT_RULES.md §R3`).

---

## 🚫 The AI never runs these (user does — `AI_AGENT_RULES.md §R1/§R2`)

- `git commit` / `git push` / any history-writing git command.
- `firebase deploy` (any target), `firebase functions:secrets:set`,
  `gcloud firestore indexes create`, `gcloud tasks queues create`.
- During development use only `firebase emulators:start`. Provide deploy/index/secret/queue
  commands as **strings for the user to copy-paste**.

---

## Verify before saying "done"

- `npm --prefix functions run typecheck` passes (0 errors).
- `npm --prefix functions run lint` passes (0 errors).
- `npm --prefix functions test` passes (when the change is unit-testable).
- Stubs left in place carry a `// TODO Sprint N:` list; don't fabricate behavior.
- Mapping to the [self-check + 5-field report](../../../docs/AI_AGENT_RULES.md) (✅做了 / 📁動了 /
  ⚠️沒做 / 🧪驗證 / 💬建議 commit message) and a journal entry — see
  [`shared quality bar`](../guides/index.md).

## Testing

Backend uses **jest + ts-jest** for unit tests — see [`testing-guidelines.md`](./testing-guidelines.md)
for the toolchain and the boundary-mocking pattern. Unit-test `onCall` handlers by mocking the
three boundaries and asserting every error branch + the success writes.

For integration / cross-layer behavior, additionally verify via `firebase emulators:start` and
report what was / wasn't exercised. Don't claim a path works if you only typechecked it.
