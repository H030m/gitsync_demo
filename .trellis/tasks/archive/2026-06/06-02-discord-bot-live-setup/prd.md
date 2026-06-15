# Invite and run Discord forwarder bot on live server

## Goal

Take the already-implemented `discord-bot/` forwarder (built in task
`06-02-discord-forwarder-bot-and-message-ingest`) and actually get it running
against the real team Discord server, so messages posted in mapped channels are
forwarded to `discordMessageIngest` and written to Firestore.

This is **ops / configuration only** — no code changes expected.

## Background

`discord-bot/` is a standalone discord.js v14 forwarder. It listens for
`MessageCreate` on mapped channels, runs a first-pass noise filter
(`shouldKeepMessage`), and POSTs survivors to the `discordMessageIngest` Cloud
Function with an `x-ingest-secret` header. The function applies a second-pass
filter + `messageId` dedup and writes to
`apps/gitsync/repos/{repoId}/discordMessages/{messageId}`. It runs separately
from Functions because stateless Cloud Functions can't hold a gateway
connection (ARCHITECTURE.md §7.2).

## Key facts / decisions (from setup session 2026-06-02)

- **Discord application client_id:** `1511330041709985792`
- **Install type:** Guild Install (`integration_type=0`). NOT user install —
  the bot needs a persistent gateway connection to read channel messages, which
  user install does not grant.
- **OAuth scope:** `bot` only (no `applications.commands` — no slash commands).
- **Bot permissions:** read-only, minimal:
  - View Channels (`1<<10`)
  - Read Message History (`1<<16`)
  - Combined `permissions=66560`. The bot never sends/edits/manages messages.
  - Minimal invite URL:
    `https://discord.com/oauth2/authorize?client_id=1511330041709985792&permissions=66560&integration_type=0&scope=bot`
  - NOTE: the first generated URL had 2 extra perms (Send Messages +
    Create Public Threads, `permissions=34359806976`). Harmless but unnecessary.
- **Message Content Intent:** MUST be enabled in Developer Portal → Bot →
  Privileged Gateway Intents, otherwise `msg.content` is empty.
- **Firebase project:** `gitsync-645b3`, region `asia-east1`.
- **Shared secret:** `DISCORD_INGEST_SECRET` must be identical in
  `discord-bot/.env` and on the function side (`functions/.secret.local` for the
  emulator, Secret Manager for prod), else the function rejects with 401.

## Steps

1. **Discord Developer Portal**
   - [ ] Confirm application + bot exist (client_id `1511330041709985792`).
   - [ ] Bot → Reset Token, copy token → `DISCORD_BOT_TOKEN`.
   - [ ] Enable **Message Content Intent**.
   - [ ] Invite bot to the team server via the minimal `permissions=66560` URL
         (guild install).

2. **Configure `discord-bot/.env`** (copy from `.env.example`)
   - [ ] `DISCORD_BOT_TOKEN`
   - [ ] `DISCORD_INGEST_SECRET` (match the function side)
   - [ ] `INGEST_URL`
         - emulator: `http://127.0.0.1:5001/gitsync-645b3/asia-east1/discordMessageIngest`
         - prod: `https://asia-east1-gitsync-645b3.cloudfunctions.net/discordMessageIngest`
   - [ ] `CHANNEL_REPO_MAP` — `channelId:repoId` pairs (enable Discord Developer
         Mode → right-click channel → Copy Channel ID).

3. **Run + verify**
   - [ ] `cd discord-bot && npm install`
   - [ ] (emulator path) set `functions/.secret.local` `DISCORD_INGEST_SECRET`
         to the same value, then `firebase emulators:start --only functions,firestore`.
   - [ ] `npm run dev` → expect `[bot] logged in as ...` + `forwarding N channel(s)`.

## Acceptance criteria

- [ ] Bot appears online in the team Discord server.
- [ ] A normal message in a mapped channel creates a doc under
      `apps/gitsync/repos/{repoId}/discordMessages`.
- [ ] Junk (`ok`, `+1`, lone emoji) is dropped — no doc written.
- [ ] Re-sending the same message returns `{ dup: true }` — no duplicate doc.

## Out of scope

- Any code change to `discord-bot/` or the ingest function.
- `onDiscordMessageCreated` embedding + AI linked-task inference (still a stub
  from the prior task).
- Production hosting / process supervision (VPS, pm2, etc.) — decide separately.
