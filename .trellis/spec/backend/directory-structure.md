# Backend Directory Structure

> "Backend" = Firebase Cloud Functions (Node.js 22 + TypeScript) under `functions/`.
> Source of truth: [`docs/COURSE_METHODS.md §8.2`](../../../docs/COURSE_METHODS.md) and
> [`docs/ARCHITECTURE.md §4`](../../../docs/ARCHITECTURE.md).

---

## Layout (this is the real, scaffolded structure)

```
functions/
├── package.json            # "engines": { "node": "22" } — pinned, do not change
├── tsconfig.json
└── src/
    ├── index.ts            # export EVERY deployable function (one re-export per line)
    ├── admin.ts            # single firebase-admin init; exports `db` + `REGION`
    ├── config.ts           # OpenAI client singleton, secret declarations, MODELS, EMBEDDING_DIM
    ├── types.ts            # zod schemas (AI flow input/output)
    ├── handlers/           # entry points: onCall / onRequest wrappers (thin)
    ├── triggers/           # Firestore + scheduled triggers (onDocumentCreated/Updated, onSchedule)
    ├── flows/              # AI flow business logic (one async fn per flow)
    ├── prompts/            # pure prompt template strings (no Handlebars)
    ├── services/           # external API clients (e.g. githubClient.ts wraps Octokit)
    └── tools/              # reusable helpers: idempotency, embedding, commitFilter,
                            # discordFilter, discordNotify
```

`lib/` (the Flutter app) is the **frontend** layer — see [`frontend/`](../frontend/index.md).

---

## Where things go

| You are writing… | Put it in… |
|---|---|
| A new callable / webhook / Cloud Tasks worker | `handlers/<name>.ts`, then re-export in `index.ts` |
| A Firestore or scheduled trigger | `triggers/<name>.ts`, then re-export in `index.ts` |
| AI orchestration logic (OpenAI calls, agentic loops) | `flows/<name>.ts` |
| A prompt string | `prompts/<name>.ts` as `export const xSystem = \`...\`` |
| A wrapper around an external API (GitHub, Discord) | `services/` (clients) or `tools/` (small helpers) |
| firebase-admin access | import `db` from `admin.ts` — **never** call `initializeApp()` again |

---

## Hard rules

- **Separation of concerns**: `handlers/` stay thin (auth check, arg validation, lock,
  delegate to a `flows/` function). Webhooks only do "verify → normalize raw payload →
  write Firestore"; all business logic / OpenAI / cross-doc updates live in `triggers/`
  (which have idempotency protection). See [`ARCHITECTURE.md §4.3 / §6.3`](../../../docs/ARCHITECTURE.md).
- **`index.ts` is just re-exports** — one `export { fn } from './...'` per line. Every
  exported symbol becomes a deployed function.
- **Region**: import `REGION` from `admin.ts` (`'asia-east1'`); never hardcode the string.
- A handler/trigger that exists but isn't implemented yet is a **stub** with a
  `logger.info('... stub')` + a `// TODO Sprint N:` list (see `triggers/onCommitCreated.ts`).
  Don't delete stubs; fill them.

---

## Naming

| Thing | Convention | Example |
|---|---|---|
| File | camelCase, matches the exported fn | `breakdownTask.ts`, `githubWebhook.ts` |
| Exported function | camelCase | `breakdownTask`, `onCommitCreated` |
| Firestore field | camelCase | `createdAt`, `linkedTaskIds` |
| zod schema | PascalCase + `Schema` | `BreakdownOutputSchema` |
