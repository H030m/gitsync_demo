// On-demand backfill poller.
//
// The bot has no public URL and no Firestore credentials, so it polls the
// secret-auth `claimDiscordFetch` function (~every pollIntervalMs). When a
// request is claimed, it REST-backfills each configured channel **incrementally**
// — starting from the channel's watermark (last fetched message id) or, on the
// first run, from its configured start date — runs the shared noise filter,
// POSTs survivors to discordMessageIngest, then reports completion plus the new
// per-channel watermark to `completeDiscordFetch`. One failing channel or request
// must not kill the loop. See ARCHITECTURE.md §7.
import {
  ChannelType,
  type Client,
  type Message,
  type TextBasedChannel,
} from 'discord.js';

import type { BotConfig } from './config';
import { shouldKeepMessage } from './filter';
import { sendWithRetry, type IngestPayload } from './ingest';
import { snowflakeForTaipeiDate, snowflakeForTaipeiDayEnd } from './snowflake';

const DISCORD_FETCH_LIMIT = 100; // max messages per REST page

interface ChannelClaim {
  channelId: string;
  startDate: string | null; // YYYY-MM-DD, set via the app date picker
  lastMessageId: string | null; // watermark — newest id ingested so far
}

interface ClaimResponse {
  none?: boolean;
  requestId?: string;
  repoId?: string;
  date?: string;
  startDate?: string | null; // repo-level backfill range (low cursor)
  endDate?: string | null; // repo-level backfill range (high cursor, inclusive day)
  channels?: ChannelClaim[]; // new per-channel shape
  channelIds?: string[]; // legacy fallback
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Normalizes a claim into per-channel work items (handles the legacy
// channelIds-only shape from older function deployments).
function resolveChannels(claim: ClaimResponse): ChannelClaim[] {
  if (Array.isArray(claim.channels)) {
    return claim.channels.map((c) => ({
      channelId: c.channelId,
      startDate: c.startDate ?? null,
      lastMessageId: c.lastMessageId ?? null,
    }));
  }
  return (claim.channelIds ?? []).map((id) => ({
    channelId: id,
    startDate: null,
    lastMessageId: null,
  }));
}

// Fetches messages in the half-open window (afterId, highCursor), paginating
// forward via the `after` cursor. `highCursor` (exclusive) bounds the range's
// end — messages with id >= highCursor are skipped, and once a batch reaches
// past it we stop. Returns the in-range messages plus the newest in-range id
// (the new watermark — never beyond the range end).
async function fetchMessagesAfter(
  channel: TextBasedChannel,
  afterId: string,
  highCursor: string | null,
): Promise<{ messages: Message[]; newWatermark: string }> {
  const collected: Message[] = [];
  const high = highCursor ? BigInt(highCursor) : null;
  let after = afterId;
  let maxInRange = afterId; // watermark stays within the range end

  for (;;) {
    const batch = await channel.messages.fetch({
      limit: DISCORD_FETCH_LIMIT,
      after,
    });
    if (batch.size === 0) break;

    let batchMax = after;
    let reachedEnd = false;
    for (const msg of batch.values()) {
      const id = BigInt(msg.id);
      if (BigInt(batchMax) < id) batchMax = msg.id; // advance over ALL ids
      if (high !== null && id >= high) {
        reachedEnd = true; // past the range end — skip but note we're done
        continue;
      }
      collected.push(msg);
      if (BigInt(maxInRange) < id) maxInRange = msg.id;
    }

    if (batchMax === after) break; // no forward progress — safety against loops
    after = batchMax;
    if (reachedEnd) break; // saw messages past the range end
    if (batch.size < DISCORD_FETCH_LIMIT) break;
  }

  return { messages: collected, newWatermark: maxInRange };
}

// Processes one claimed fetch request: incrementally backfills each channel,
// POSTs survivors, and reports completion + new watermarks. Never throws.
async function processRequest(client: Client, cfg: BotConfig, claim: ClaimResponse): Promise<void> {
  const { requestId, repoId, date } = claim;
  if (!requestId || !repoId || !date) {
    console.error('[backfill] malformed claim response, skipping', claim);
    return;
  }
  const channels = resolveChannels(claim);

  // High cursor (exclusive upper bound) from the repo-level range end; null when
  // no range is configured (no upper bound → fetch up to "now").
  let highCursor: string | null = null;
  if (claim.endDate) {
    try {
      highCursor = snowflakeForTaipeiDayEnd(claim.endDate);
    } catch (e) {
      console.error(`[backfill] bad endDate ${claim.endDate}: ${String(e)}`);
    }
  }
  console.log(
    `[backfill] claimed ${requestId} repo=${repoId} range=${claim.startDate ?? '-'}..${claim.endDate ?? '-'} channels=${channels.length}`,
  );

  let ingestedCount = 0;
  const watermarks: Array<{ channelId: string; lastMessageId: string }> = [];

  for (const ch of channels) {
    try {
      const channel = await client.channels.fetch(ch.channelId);
      if (
        !channel ||
        !channel.isTextBased() ||
        channel.type === ChannelType.DM ||
        channel.type === ChannelType.GroupDM
      ) {
        console.warn(`[backfill] channel ${ch.channelId} not a guild text channel, skipping`);
        continue;
      }

      // Low cursor: explicit per-channel watermark wins; else the repo-level
      // range start; else the per-channel start date; else the request's day.
      // Each channel resolves its OWN watermark — there is no shared watermark.
      const lowDate = claim.startDate ?? ch.startDate ?? date;
      let after: string;
      try {
        after = ch.lastMessageId ?? snowflakeForTaipeiDate(lowDate);
      } catch (e) {
        console.error(`[backfill] bad start date for channel ${ch.channelId}: ${String(e)}`);
        continue;
      }
      // Per-channel cursor trace: confirms each channel reads from its own
      // marker. If two channels log the same cursor, that channel's stored
      // watermark is stale (clear it via the app's "Start date" button).
      const cursorSource = ch.lastMessageId
        ? 'watermark'
        : claim.startDate
          ? 'rangeStart'
          : ch.startDate
            ? 'startDate'
            : 'requestDate';
      console.log(
        `[backfill] channel ${ch.channelId} cursor=${after} (${cursorSource}) high=${highCursor ?? '-'}`,
      );

      const { messages, newWatermark } = await fetchMessagesAfter(channel, after, highCursor);
      for (const msg of messages) {
        if (
          !shouldKeepMessage({
            isBot: msg.author.bot,
            content: msg.content,
            attachmentCount: msg.attachments.size,
          })
        ) {
          continue;
        }
        const payload: IngestPayload = {
          repoId,
          messageId: msg.id,
          channelId: msg.channelId,
          authorId: msg.author.id,
          // The name humans see in Discord: guild nickname → global display
          // name → @handle. Stored as authorName so panels/search use the
          // recognizable name (e.g. "鯨魚島麻糬"), not the raw username.
          authorName:
            msg.member?.displayName ??
            msg.author.globalName ??
            msg.author.username,
          // Keep the @handle too, so a search by username still matches.
          authorUsername: msg.author.username,
          content: msg.content,
          mentionedUserIds: [...msg.mentions.users.keys()],
          timestamp: msg.createdAt.toISOString(),
        };
        const ok = await sendWithRetry(cfg, payload);
        if (ok) ingestedCount++;
      }

      // Advance the watermark only if we actually saw new messages.
      if (messages.length > 0) {
        watermarks.push({ channelId: ch.channelId, lastMessageId: newWatermark });
      }
    } catch (e) {
      // One failing channel must not abort the whole request.
      console.error(`[backfill] channel ${ch.channelId} failed: ${String(e)}`);
    }
  }

  console.log(`[backfill] request ${requestId} ingested ${ingestedCount} message(s)`);
  await reportComplete(cfg, repoId, requestId, ingestedCount, watermarks);
}

// POSTs completion to completeDiscordFetch. Logged-only on failure.
async function reportComplete(
  cfg: BotConfig,
  repoId: string,
  requestId: string,
  ingestedCount: number,
  watermarks: Array<{ channelId: string; lastMessageId: string }>,
): Promise<void> {
  try {
    const res = await fetch(cfg.completeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ingest-secret': cfg.ingestSecret,
      },
      body: JSON.stringify({ repoId, requestId, ingestedCount, watermarks }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[backfill] completeDiscordFetch ${requestId} HTTP ${res.status}`);
    }
  } catch (e) {
    console.error(`[backfill] completeDiscordFetch ${requestId} failed: ${String(e)}`);
  }
}

// Polls claimDiscordFetch once. Returns true if a request was claimed and
// processed (so the caller can poll again immediately rather than waiting).
async function pollOnce(client: Client, cfg: BotConfig): Promise<boolean> {
  let claim: ClaimResponse;
  try {
    const res = await fetch(cfg.claimUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ingest-secret': cfg.ingestSecret,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[backfill] claimDiscordFetch HTTP ${res.status}`);
      return false;
    }
    claim = (await res.json()) as ClaimResponse;
  } catch (e) {
    console.error(`[backfill] claimDiscordFetch failed: ${String(e)}`);
    return false;
  }

  if (claim.none) return false;
  await processRequest(client, cfg, claim);
  return true;
}

// Starts the never-ending poll loop. Runs in the background; never rejects.
export function startBackfillPoller(client: Client, cfg: BotConfig): void {
  console.log(`[backfill] poller started (interval ${cfg.pollIntervalMs}ms)`);
  void (async () => {
    for (;;) {
      let claimed = false;
      try {
        claimed = await pollOnce(client, cfg);
      } catch (e) {
        // Defensive: pollOnce already guards, but never let the loop die.
        console.error(`[backfill] poll loop error: ${String(e)}`);
      }
      // If we just processed a request there may be more queued — poll again
      // immediately; otherwise wait the configured interval.
      if (!claimed) await sleep(cfg.pollIntervalMs);
    }
  })();
}
