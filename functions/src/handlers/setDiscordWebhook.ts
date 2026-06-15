// setDiscordWebhook (callable) — persists a Discord channel webhook URL and
// channel ID list on the repo doc. Used for outbound notifications +
// forwarder routing.
import { onCall, HttpsError } from 'firebase-functions/v2/https';

import { db, REGION } from '../admin';

export const setDiscordWebhook = onCall(
  { region: REGION },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const { repoId, webhookUrl, channelIds } = request.data as {
      repoId?: string;
      webhookUrl?: string;
      channelIds?: string[];
    };
    if (!repoId) {
      throw new HttpsError('invalid-argument', 'repoId is required');
    }
    await db.doc(`apps/gitsync/repos/${repoId}`).update({
      discordWebhookUrl: webhookUrl ?? null,
      discordChannelIds: channelIds ?? [],
    });
    return { ok: true };
  },
);
