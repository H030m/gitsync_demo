// setRepoChannel (onRequest, secret-auth) — the bot's `/gitsync-listen` slash
// command calls this to bind a Discord channel to a repo. The bot has no
// Firestore credentials, so it goes through this shared-secret endpoint (same
// auth as discordMessageIngest). Reuses parseGithubUrl to derive the repoId.
// See ARCHITECTURE.md §7.
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';

import { db, REGION } from '../admin';
import { discordIngestSecret } from '../config';
import { parseGithubUrl } from '../tools/githubUrl';

export const setRepoChannel = onRequest(
  { region: REGION, secrets: [discordIngestSecret], maxInstances: 10 },
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
      githubUrl?: string;
      guildId?: string;
      channelId?: string;
    };
    const { githubUrl, guildId, channelId } = body;
    if (!githubUrl || typeof githubUrl !== 'string') {
      res.status(400).send({ error: 'githubUrl is required' });
      return;
    }
    if (!guildId || typeof guildId !== 'string') {
      res.status(400).send({ error: 'guildId is required' });
      return;
    }
    if (!channelId || typeof channelId !== 'string') {
      res.status(400).send({ error: 'channelId is required' });
      return;
    }

    const parsed = parseGithubUrl(githubUrl);
    if (!parsed) {
      res.status(400).send({ error: 'githubUrl could not be parsed into owner/repo' });
      return;
    }
    const repoId = `${parsed.owner}_${parsed.repo}`;

    const repoRef = db.doc(`apps/gitsync/repos/${repoId}`);
    const repoSnap = await repoRef.get();
    if (!repoSnap.exists) {
      res.status(404).send({ error: `repo ${repoId} not found` });
      return;
    }

    await repoRef.update({
      discordChannelIds: FieldValue.arrayUnion(channelId),
      discordGuildId: guildId,
    });
    // Per-channel config doc holds startDate + watermark (lastMessageId).
    // merge:true so re-binding a configured channel keeps its existing state.
    await repoRef.collection('discordChannels').doc(channelId).set(
      { guildId, addedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

    logger.info('setRepoChannel bound channel', { repoId, channelId });
    res.status(200).send({ repoId });
  },
);
