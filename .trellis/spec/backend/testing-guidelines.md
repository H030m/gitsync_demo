# Testing Guidelines (Cloud Functions)

> How backend unit tests are set up and written in `functions/`.
> Established by task `06-02-add-repo-callable` (first backend test suite).
> Source of truth for the toolchain: `functions/package.json`, `functions/jest.config.js`.

---

## Toolchain

- **Runner**: `jest` + `ts-jest` (TypeScript, Node 22). Chosen because Node's native
  `mock.module` is unavailable in this runtime and ts-jest typechecks tests at run time.
- **Run**: `npm --prefix functions test`.
- **Location**: `functions/src/__tests__/*.test.ts` — one test file per handler/service.
- **Build isolation**: `tsconfig.json` **excludes** `src/**/__tests__/**` so tests are never
  emitted into the deploy `lib/` bundle. Never remove that exclude.

---

## Convention: mock at the boundaries, run the real handler

**What**: A callable's logic is tested by mocking its three boundaries and invoking the raw
handler — no emulator needed for unit level.

**Why**: Fast, deterministic, covers every error branch (auth, validation, external failure)
that an emulator round-trip makes awkward.

**The three boundaries to mock**:

| Boundary | How |
|---|---|
| `firebase-functions/v2/https` `onCall` | mock so it returns the raw handler fn → call `handler({ auth, data })` directly |
| `../admin` `db` | fake Firestore object (in-memory `doc`/`get`/`batch` spies) |
| `../services/githubClient` (or other service) | `jest.mock` the service module; assert it's called with the right args |

**Example** (shape used in `__tests__/addRepo.test.ts`):

```typescript
jest.mock('firebase-functions/v2/https', () => ({
  onCall: (_opts: unknown, handler: unknown) => handler, // expose raw handler
  HttpsError: class extends Error { constructor(public code: string, msg: string){ super(msg) } },
}));
jest.mock('../admin', () => ({ db: fakeDb, REGION: 'asia-east1' }));
jest.mock('../services/githubClient');

// then: await expect(addRepo({ auth: null, data: {} })).rejects.toMatchObject({ code: 'failed-precondition' })
```

> GitHub/OpenAI/Discord calls are mocked via the **service module** (`githubClient.ts` etc.),
> never by importing `@octokit/rest` in the test — this is the same "all API calls go through
> the service layer" discipline as production code (ARCHITECTURE §6.4).

---

## What to cover

For an `onCall` handler, assert at minimum:
- auth missing → correct `HttpsError.code`
- each input-validation failure → `invalid-argument`
- each external/precondition failure → its mapped code (e.g. 404 → `not-found`)
- the success path → correct return value **and** the expected Firestore writes happened
- best-effort branches → main write still succeeds when the optional side-effect throws
  (see [`error-handling.md`](./error-handling.md) best-effort pattern)

Assertion points: the thrown `code`, the `{ ... }` return, and the args passed to the
batch/service mocks (e.g. all writes used `apps/gitsync/` paths).

---

## Lint

- **ESLint 10 flat config** at `functions/eslint.config.js`; script is `eslint src`
  (ESLint 10 removed `--ext`).
- `no-console` is an **error** — use the structured `logger` ([`logging-guidelines.md`](./logging-guidelines.md)).
- Unused vars honor the `_`-prefix convention used by stub params across `flows/`.
