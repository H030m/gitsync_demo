// Outbound Discord notifications via channel webhook URLs.
// Single-direction POST → no 3-second response constraint, no signing.
import { logger } from 'firebase-functions/v2';

/**
 * POSTs `{ content }` to the given Discord channel webhook URL. Errors are
 * swallowed (a failed notification must never break the main flow — the
 * Firestore write that triggered us has already succeeded).
 */
export async function notifyDiscord(
  webhookUrl: string | null | undefined,
  content: string,
): Promise<void> {
  if (!webhookUrl) return;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logger.warn('Discord notify failed', {
        status: res.status,
        statusText: res.statusText,
      });
    }
  } catch (e) {
    logger.warn('Discord notify error', { error: String(e) });
  }
}
