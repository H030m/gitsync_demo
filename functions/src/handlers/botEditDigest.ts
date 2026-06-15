// botEditDigest (onRequest, secret-auth) — bridge for the Discord bot's
// `/gitsync-digest` command. The bot has no Firestore credentials, so it POSTs
// the channel it was invoked in + the instruction here; we resolve the repo
// from the channel binding and run the shared edit flow. Mirrors the secret
// auth of discordMessageIngest / completeDiscordFetch. See ARCHITECTURE §7.
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';

import { REGION } from '../admin';
import { discordIngestSecret, openaiKey } from '../config';
import {
  editDiscordDigestFlow,
  repoIdForChannel,
  taipeiTodayString,
} from '../flows/editDiscordDigest';

export const botEditDigest = onRequest(
  { region: REGION, secrets: [discordIngestSecret, openaiKey], maxInstances: 5 },
  async (req, res) => {
    if (req.header('x-ingest-secret') !== discordIngestSecret.value()) {
      res.status(401).send({ error: 'bad secret' });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).send({ error: 'method not allowed' });
      return;
    }

    const body = (req.body ?? {}) as {
      channelId?: string;
      date?: string;
      instruction?: string;
    };
    const { channelId, instruction } = body;
    if (!channelId || !instruction || !instruction.trim()) {
      res.status(400).send({ error: 'channelId and instruction are required' });
      return;
    }

    const repoId = await repoIdForChannel(channelId);
    if (!repoId) {
      res.status(404).send({ error: 'channel is not bound to any repo' });
      return;
    }
    const date =
      typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : taipeiTodayString(new Date());

    try {
      const result = await editDiscordDigestFlow({
        repoId,
        date,
        instruction: instruction.trim(),
      });
      logger.info('botEditDigest done', { repoId, date });
      res.status(200).send({ ok: true, repoId, date, markdown: result.markdown });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'not-found') {
        res.status(404).send({ error: `no digest for ${date} yet` });
        return;
      }
      if (code === 'failed-precondition') {
        res.status(409).send({ error: 'digest is locked' });
        return;
      }
      logger.error('botEditDigest failed', { repoId, date, error: String(e) });
      res.status(500).send({ error: 'edit failed' });
    }
  },
);
