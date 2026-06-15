# GitSync Cloud Functions

TypeScript Cloud Functions for the GitSync project. Region pinned to `asia-east1`.

## Layout

```
src/
├── index.ts                # Exports every onCall / trigger / onRequest
├── config.ts               # OpenAI client + defineSecret + MODELS
├── types.ts                # Zod schemas (AI input/output contracts)
├── admin.ts                # firebase-admin init + db handle
├── handlers/               # onCall + onRequest entry points
│   ├── addRepo.ts
│   ├── removeRepo.ts
│   ├── breakdownTask.ts
│   ├── forceUnlockBreakdown.ts
│   ├── assignTask.ts
│   ├── generateHandoff.ts
│   ├── summarizeDay.ts
│   ├── setDiscordWebhook.ts
│   ├── subscribeToTopic.ts
│   ├── githubWebhook.ts          (onRequest — raw write only)
│   ├── discordMessageIngest.ts   (onRequest — raw write only)
│   └── dailyReportWorker.ts      (onRequest — fanout worker)
├── triggers/               # Firestore + scheduled triggers (AI happens here)
│   ├── onTaskCreated.ts
│   ├── onTaskUpdated.ts
│   ├── onCommitCreated.ts
│   ├── onPRMerged.ts
│   ├── onDiscordMessageCreated.ts
│   ├── scheduledDailyReport.ts
│   └── scheduledUnstickBreakdown.ts
├── flows/                  # OpenAI flows (no Firebase entry-point boilerplate)
│   ├── breakdownTask.ts
│   ├── assignTask.ts
│   ├── generateHandoff.ts
│   └── summarizeDay.ts
├── prompts/                # System / user prompt strings
│   ├── breakdownTask.ts
│   ├── assignTask.ts
│   ├── generateHandoff.ts
│   └── summarizeDay.ts
├── tools/                  # Reusable utilities (filters, idempotency, etc.)
│   ├── commitFilter.ts
│   ├── discordFilter.ts
│   ├── discordNotify.ts
│   ├── idempotency.ts
│   └── embedding.ts
└── services/               # External clients
    ├── githubClient.ts
    └── openaiClient.ts     (re-exports from config.ts)
```

## Local dev (emulator)

```powershell
npm install
# Copy .secret.local.example → .secret.local and fill in real keys
firebase emulators:start --only functions,firestore
```

## Type check

```powershell
npm run typecheck
```

## Deploy (run by a *human*, not the AI — see AI_AGENT_RULES.md §R2)

```powershell
firebase deploy --only functions
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

## Secrets

Set with `firebase functions:secrets:set <NAME>`. Required:

| Secret | Used by |
|---|---|
| `OPENAI_API_KEY` | every flow + trigger that calls OpenAI |
| `DISCORD_INGEST_SECRET` | `discordMessageIngest` |

See [`../secrets/README.md`](../secrets/README.md) for the local development counterpart.
