# Logging Guidelines (Cloud Functions)

> Use the Firebase structured logger, never `console.log`.

---

## Logger

```ts
import { logger } from 'firebase-functions/v2';
```

Logs surface in the Firebase console / Cloud Logging with structured fields. Pass context as
a second-argument object, not via string interpolation:

```ts
logger.info('Skipping commit embedding (filter hit)', { sha: event.params.sha });
logger.info('onCommitCreated stub', { ids: event.params });
logger.error('breakdownTaskFlow failed', { repoId, err });
```

---

## Levels

| Level | When |
|---|---|
| `logger.debug` | Verbose local-only detail; off by default in prod |
| `logger.info` | Normal milestones: flow steps, "already processed, skipping", stub markers |
| `logger.warn` | Recoverable anomalies (e.g. external call failed, falling back to null) |
| `logger.error` | Unexpected failures, caught exceptions you can't recover from |

The AI-flow step logging style (`logger.info('Step 1: fetch project context')`) from
[`COURSE_METHODS.md §8.6`](../../../docs/COURSE_METHODS.md) is the expected pattern inside `flows/`.

---

## What to log

- Trigger entry/skip decisions (idempotency hit, filter hit).
- Flow step boundaries and round counts in agentic loops.
- External call failures (with the identifier, not the whole payload).

## What NOT to log

- **Never log secrets**: `OPENAI_API_KEY`, `DISCORD_INGEST_SECRET`, `webhookSecret`,
  `githubAccessToken`.
- Don't dump full request bodies or large payloads — log the id (`sha`, `messageId`, `repoId`).
- Don't log user PII beyond the ids already in the schema.
