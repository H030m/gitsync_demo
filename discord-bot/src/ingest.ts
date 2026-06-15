// POSTs a normalized message to the discordMessageIngest Cloud Function with
// exponential-backoff retry. See ARCHITECTURE.md §7.2 "sendWithRetry".
//
// Why retry: Cloud Functions cold-start takes 1.5–3s; a burst of messages can
// hit cold starts + 429s at once. Backoff with jitter spreads retries until the
// function warms up, so chat isn't dropped (which would leave gaps in RAG data).
import type { BotConfig } from './config';

// Keep in sync with discordMessageIngest.ts IngestPayload.
export interface IngestPayload {
  repoId: string;
  messageId: string;
  channelId: string;
  authorId: string;
  authorName: string; // display name (guild nickname → global → @handle)
  authorUsername?: string; // the raw @handle, for username-based matching
  content: string;
  mentionedUserIds: string[];
  timestamp: string; // ISO 8601
}

const MAX_RETRIES = 4; // 5 attempts total: delays 1s → 2s → 4s → 8s
const BASE_DELAY_MS = 1000;
const PER_ATTEMPT_TIMEOUT_MS = 8000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sendWithRetry(
  cfg: BotConfig,
  payload: IngestPayload,
): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cfg.ingestUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ingest-secret': cfg.ingestSecret,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS),
      });

      if (res.ok) return true;

      // 4xx other than 429 (e.g. 401 bad secret, 400 bad payload) won't get
      // better on retry — drop immediately.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        console.error(
          `[ingest] dropping ${payload.messageId}: non-retryable ${res.status}`,
        );
        return false;
      }
      // 5xx / 429 → fall through to retry.
      console.warn(`[ingest] attempt ${attempt + 1} for ${payload.messageId}: HTTP ${res.status}`);
    } catch (e) {
      // Network error / timeout → retry.
      console.warn(`[ingest] attempt ${attempt + 1} for ${payload.messageId} failed: ${String(e)}`);
    }

    if (attempt < MAX_RETRIES) {
      const backoff = BASE_DELAY_MS * 2 ** attempt;
      const jitter = Math.floor(Math.random() * 500);
      await sleep(backoff + jitter);
    }
  }

  console.error(`[ingest] CRITICAL: gave up on ${payload.messageId} after ${MAX_RETRIES + 1} attempts`);
  return false;
}
