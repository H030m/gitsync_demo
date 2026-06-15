# Scheduled Discord ingest, daily-report refresh, and per-repo channel config

## Goal

Move Discord ingestion from the always-on real-time gateway forwarder toward a
**batch / on-demand** model, and make channel→repo mapping **dynamic** (chosen
per repo via GitHub URL) instead of a static `.env` map. Three sub-features:

1. **Scheduled daily ingest** — the bot pulls each mapped channel's last-day
   messages on a daily timer and writes them to Firestore.
2. **Daily-report refresh button** — in the app's Daily → Discord tab, a refresh
   button triggers the bot to fetch the day's messages, organize them, and write
   a document into Firebase so the AI (daily summary) can read it.
3. **Per-repo channel config** — give the bot a GitHub repo URL (e.g.
   `https://github.com/H030m/gitsync.git`), then select one or more channels (in
   one or more guilds the bot is in) to listen to; that repo only ingests its
   configured channels.

## What I already know (from repo inspection)

* **Current bot** (`discord-bot/src/`) is a discord.js v14 **real-time**
  forwarder: `MessageCreate` → `shouldKeepMessage` filter → `sendWithRetry`
  POST to `discordMessageIngest`. Channel mapping is a **static env var**
  `CHANNEL_REPO_MAP` ("channelId:repoId,..." parsed in `config.ts`).
* **Bot has no public inbound URL** — runs on a laptop/VPS because stateless
  Cloud Functions can't hold a gateway connection (`ARCHITECTURE.md §7.2`).
  ⇒ The app / a schedule cannot call the bot directly; any "trigger the bot"
  must be **indirect**.
* `discordMessageIngest` (`functions/src/handlers/`) validates `x-ingest-secret`,
  runs second-pass filter, dedups via `ref.create()` (messageId = doc id),
  writes `apps/gitsync/repos/{repoId}/discordMessages/{messageId}`.
* `repos/{repoId}` already has `discordChannelIds: string[]` and
  `discordWebhookUrl` fields; `setDiscordWebhook` callable writes them.
* Daily report: `scheduledDailyReport` (18:00 Taipei) → fan-out (Cloud Tasks
  **TODO Sprint 4**) → `dailyReportWorker` → `summarizeDayFlow` (**stub**).
* `DailyViewPage` (`lib/views/daily/daily_view_page.dart`) has tabs
  Summary / Commits / Discord. Summary tab already has a `Regenerate`
  button (`vm.regenerate` + `vm.regenerating`) — pattern to mirror for the
  Discord refresh. Discord tab currently only lists messages.
* `DiscordMessagesViewModel` streams `repos/{repoId}/discordMessages`.

## Decisions locked (Q&A 2026-06-02)

1. **NO scheduled daily ingest.** On-demand only — the Daily → Discord refresh
   button is the sole trigger. (Sub-feature #1 from the original ask is cut.)
2. **Replace real-time forwarding with batch.** Drop the `MessageCreate`
   forwarder. The bot does an on-demand REST backfill of the day's messages when
   asked.
3. **Organized doc = AI-written daily digest.** After backfill, an AI step
   cleans/summarizes the day's chat into a per-day digest doc the daily summary
   (and later handoff) reads.
4. **Channel config via a Discord command to the bot** (give GitHub repo URL +
   select channel(s)) — NOT an in-app picker. Bot persists the mapping.

## Derived facts (from code, no need to ask)

* `repoId = ${owner}_${repo}` (e.g. `H030m_gitsync`), parsed by
  `parseGithubUrl()` in `functions/src/handlers/addRepo.ts` — the Discord
  command reuses this to turn the URL into a repoId.
* `repos/{repoId}.discordChannelIds: string[]` already exists (Repo model +
  Firestore) — channel selection persists here (+ a `discordGuildId` likely
  needed for multi-guild).
* The bot has **no Firestore credentials** today — it only POSTs to functions
  with `x-ingest-secret`. So bot→Firestore writes (config mapping, fetch
  results) must go **through Cloud Functions**, not direct.

## Decisions locked (final forks 2026-06-02)

5. **Trigger = Firestore-backed request queue.** App refresh → callable writes a
   `fetchRequests` doc; the always-on bot claims it and backfills. (No bot
   public URL.)
6. **Config = Discord slash command** `/gitsync-listen url:<repo-url>` (binds the
   channel it's run in; run once per channel for multiple). Requires
   re-inviting the bot with the `applications.commands` scope.

## Requirements

* **Bot (`discord-bot/`)**
  * Keep the gateway connection, but **remove `MessageCreate` real-time
    forwarding**.
  * On ready, register a guild slash command `/gitsync-listen url:<repo-url>`
    (optional `/gitsync-unlisten`). Handler parses the URL → repoId and calls a
    Cloud Function to persist `{repoId, guildId, channelId}`; replies ephemeral.
  * Claim pending fetch requests (see trigger design), REST-backfill the day's
    messages for the repo's channels, run the existing noise filter, POST
    survivors to `discordMessageIngest`, then signal completion.
* **Functions (`functions/`)**
  * `requestDiscordFetch` (callable) — auth check → write `fetchRequests/{id}`
    `{repoId, date, status:'pending'}`.
  * Bot-facing endpoints (secret-auth, mirror `discordMessageIngest`):
    claim a pending request + mark it complete.
  * `setRepoChannel` (secret-auth, onRequest) — `arrayUnion` channelId into
    `repos/{repoId}.discordChannelIds`, set `discordGuildId`. Reuse
    `parseGithubUrl`.
  * On completion → run an AI daily digest flow that writes
    `repos/{repoId}/discordDigests/{date}` (markdown summary of the day's chat).
  * Firestore rules: `fetchRequests` + `discordDigests` `allow write: if false`
    (functions only); `discordDigests` readable by repo members.
* **App (`lib/views/daily/`)**
  * Daily → Discord tab: add a refresh button mirroring the Summary tab's
    `Regenerate` (`vm.refreshing` flag + spinner).
  * `DiscordMessagesViewModel.refresh()` → call `requestDiscordFetch`, watch the
    request status + stream the produced digest, render it above the message
    list.

## Acceptance Criteria

* [ ] Running `/gitsync-listen url:https://github.com/H030m/gitsync.git` in a
      channel adds that channelId to `repos/H030m_gitsync.discordChannelIds`.
* [ ] The bot no longer forwards messages in real time (MessageCreate path gone).
* [ ] Tapping refresh in Daily → Discord writes a `fetchRequests` doc, the bot
      backfills the day's messages into `discordMessages`, and a
      `discordDigests/{date}` doc is produced.
* [ ] The refresh button shows a spinner while in flight and the digest renders
      when done.
* [ ] `functions` typecheck, `discord-bot` build, and `flutter analyze` are all
      green.
* [ ] `ARCHITECTURE.md §7` rewritten to the new model; `MEMORY.md` records the
      "channel map moved to Firestore + real-time forwarding removed" decision.

## Technical Approach

**End-to-end refresh flow**

```
App refresh ─▶ requestDiscordFetch (callable, auth)
                 └▶ fetchRequests/{id} {repoId, date, status:'pending'}
Bot (always-on) ─ claims pending request ─▶ Discord REST GET /channels/{id}/messages
                 (per channel in repo.discordChannelIds, since date 00:00)
                 ─ shouldKeepMessage filter ─▶ POST discordMessageIngest (reuse)
                 ─ mark request 'ingested'
Completion ─▶ discordDailyDigestFlow ─▶ discordDigests/{date} (AI markdown)
App ─ streams fetchRequests/{id}.status + discordDigests/{date} ─▶ UI
```

**Bot ↔ queue (keep bot credential-free).** The bot today has **no GCP
credentials** — only the shared `x-ingest-secret`. Recommended: keep it that
way — the bot **polls a secret-auth `claimDiscordFetch` function** (~5 s) that
reads `fetchRequests` and atomically marks one `claimed`; on finish it calls
`completeDiscordFetch`. Alternative (lower latency, more setup): give the bot a
Firebase Admin service account and use `onSnapshot`. **Decision: poll-via-
function for MVP** unless we hit latency problems — avoids handing the bot a
service-account key.

**Config command auth (MVP gap).** Any guild member who knows a repo URL can
bind a channel to it via `/gitsync-listen`. Acceptable for the demo; noted as a
future hardening item (e.g. verify the invoker is a repo member).

## Decision (ADR-lite)

**Context**: Bot is a laptop/VPS process with no public URL; team wants
on-demand (not scheduled) ingest, in-Discord channel config, and an AI-organized
daily doc.
**Decision**: Drop real-time forwarding + scheduled ingest. Bot becomes a
command + backfill worker driven by a Firestore request queue (claimed via a
secret-auth function) and a slash command. AI digest written to
`discordDigests/{date}`.
**Consequences**: Bot must still run 24/7 (for slash commands). Slash commands
need an `applications.commands` re-invite. Messages are only as fresh as the
last refresh (acceptable — handoff-over-Discord is deferred per the earlier
MEMORY decision). Reuses `discordMessageIngest` + `x-ingest-secret`, so no new
bot credentials.

## Implementation Plan (small PRs)

* **PR1 — functions + rules**: `requestDiscordFetch`, `claimDiscordFetch`,
  `completeDiscordFetch`, `setRepoChannel`, `discordDailyDigestFlow` +
  `discordDigests` write; Firestore rules + any index; unit tests
  (parse + digest). 
* **PR2 — discord-bot**: remove MessageCreate forwarding; register
  `/gitsync-listen`; REST backfill module; queue-claim poller; wire config →
  `setRepoChannel`. Build green.
* **PR3 — Flutter**: Daily → Discord refresh button + `vm.refresh()` + digest
  rendering. `flutter analyze` green.
* **Docs**: rewrite `ARCHITECTURE.md §7`; add `MEMORY.md` decision.

## Definition of Done (team quality bar)

* `functions` typecheck + `discord-bot` build + `flutter analyze` all green
* Follows AI_AGENT_RULES (English code/comments, no auto-commit/deploy)
* Firestore writes go through Cloud Functions (rules keep `discordMessages`
  `allow write: if false`)
* Docs updated: `ARCHITECTURE.md §7` + `MEMORY.md` decision if mapping moves
  to Firestore

## Out of Scope (explicit)

* Scheduled/automatic daily ingest (cut — on-demand refresh only).
* Real-time message forwarding (removed).
* Auth on who may bind a channel→repo via the slash command (MVP accepts any
  guild member; future hardening).
* Handoff flow consuming the digest (digest is written; wiring it into
  `generateHandoffFlow` is deferred per the earlier MEMORY decision).
* Giving the bot a Firebase Admin service account (using poll-via-function
  instead).
* Multi-channel selection in a single command (run `/gitsync-listen` once per
  channel).

## Technical Notes

* Bot reachability constraint is the central design driver (no public URL).
* `discord-bot` is a **separate package**, not in `functions/`. Both share the
  noise-filter rules (`discordFilter.ts` ↔ bot `filter.ts`).
* Discord REST message backfill (`GET /channels/{id}/messages`) needs cursor
  state per channel + may have Message-Content-intent caveats vs gateway —
  verify during implementation.
