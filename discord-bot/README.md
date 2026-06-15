# GitSync Discord Bot

Provides per-channel→repo config and on-demand message backfill for GitSync.
Backfilled messages are written to Firestore
(`apps/gitsync/repos/{repoId}/discordMessages/{messageId}`) via the
`discordMessageIngest` Cloud Function. Later AI flows (daily digest / handoff)
RAG-search these messages.

This bot runs **separately** from the Firebase Functions repo because Cloud
Functions are stateless and can't hold a persistent Discord gateway connection
(ARCHITECTURE.md §7).

> **Real-time forwarding has been removed.** The bot no longer forwards every
> message as it arrives. Channel→repo mapping now lives in Firestore (set via
> the `/gitsync-listen` slash command), and messages are pulled on demand when
> the app's Daily → Discord refresh button enqueues a fetch request.

## How it works

```
Config:  /gitsync-listen url:<repo-url>  (run in a channel)
  → POST {githubUrl, guildId, channelId} with x-ingest-secret → setRepoChannel
  → repos/{repoId}.discordChannelIds arrayUnion(channelId)

Backfill: app refresh → fetchRequests/{id} (pending)
  → bot polls claimDiscordFetch (~every 5s) → claims a request {repoId, date, channelIds}
  → for each channel: REST channel.messages.fetch (paginated) for that Taipei day
  → shouldKeepMessage() first-pass filter (else drop — saves a function call)
  → POST {payload} with x-ingest-secret → discordMessageIngest
        → second-pass filter + messageId dedup → Firestore
  → POST {repoId, requestId, ingestedCount} → completeDiscordFetch (runs digest)
```

Noise is filtered twice (here + server-side) and deduped by `messageId`, so junk
and resends don't flood the database.

## Setup

1. **Create + invite the Discord bot**
   - [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot.
   - Enable **Message Content Intent** (Bot → Privileged Gateway Intents). This
     is still required: REST message backfill only returns message `content`
     when this privileged intent is on.
   - Copy the bot token. Invite the bot with **both** the `bot` **and
     `applications.commands`** scopes (the latter is required for slash
     commands — re-invite with this scope if your existing invite lacks it),
     plus "Read Messages/View Channels" + "Read Message History" permissions.

2. **Install + configure**
   ```powershell
   cd discord-bot
   npm install
   Copy-Item .env.example .env
   # edit .env: DISCORD_BOT_TOKEN, DISCORD_INGEST_SECRET, FUNCTIONS_BASE_URL
   ```
   - `DISCORD_INGEST_SECRET` must match what the Cloud Functions use
     (`functions/.secret.local` for the emulator, Secret Manager in prod).
   - `FUNCTIONS_BASE_URL`: emulator vs prod base — see `.env.example`. The bot
     appends each function name to derive its URL.
   - `POLL_INTERVAL_MS` (optional): backfill poll interval, default 5000ms.

3. **Run**
   ```powershell
   npm run dev       # tsx watch (development)
   # or
   npm run build && npm start
   ```

## Usage

- In any channel the bot can see, run
  `/gitsync-listen url:https://github.com/owner/repo.git`. The repo must already
  exist in the app (added via Add Repo) or you'll get
  "repo not found — add it in the app first". On success the bot replies
  (ephemeral) "Now listening this channel for `owner_repo`". Run it once per
  channel you want bound.
- Tapping **refresh** in the app's Daily → Discord tab enqueues a fetch request;
  the bot backfills that day's messages from every bound channel.

## Local end-to-end test (with the Firebase emulator)

```powershell
# Terminal 1 — from repo root
Copy-Item functions/.secret.local.example functions/.secret.local   # set DISCORD_INGEST_SECRET
firebase emulators:start --only functions,firestore

# Terminal 2 — discord-bot/ with .env pointing FUNCTIONS_BASE_URL at the emulator
npm run dev
```

- Run `/gitsync-listen` in a channel → `discordChannelIds` on the repo doc gains
  the channel id (visible in the Firestore emulator UI, http://127.0.0.1:4000).
- Enqueue a fetch request (app refresh, or write a `fetchRequests` doc) → the
  bot backfills the day's messages into `discordMessages`; junk (`ok`, `+1`, a
  lone emoji, `haha`) is dropped and resends return `{ dup: true }`.

## Keep in sync

`src/filter.ts` deliberately mirrors `functions/src/tools/discordFilter.ts`, and
`src/backfill.ts`'s Taipei day bounds mirror
`functions/src/flows/discordDailyDigest.ts`. If you change either, change both.
