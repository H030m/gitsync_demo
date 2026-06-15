// discordMessageIngest (onRequest) — receives normalized Discord messages from
// the forwarder bot. Verifies the shared secret, runs the noise filter, and
// writes the raw doc. AI work (embedding, linked-task detection) happens in
// `onDiscordMessageCreated`. See ARCHITECTURE.md §7.2.
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { db, REGION } from '../admin';
import { discordIngestSecret } from '../config';
import { shouldKeepMessage } from '../tools/discordFilter';

// Payload the forwarder bot POSTs. Keep in sync with discord-bot/src/ingest.ts.
interface IngestPayload {
  repoId: string;
  messageId: string;
  channelId: string;
  authorId: string;
  authorName: string; // display name (guild nickname → global → @handle)
  authorUsername?: string; // raw @handle (optional; older bots omit it)
  content: string;
  mentionedUserIds: string[];
  timestamp: string; // ISO 8601
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === 'string');
}

// Returns the validated payload, or null if any field is missing / mistyped.
function parsePayload(body: unknown): IngestPayload | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const strFields = [
    'repoId',
    'messageId',
    'channelId',
    'authorId',
    'authorName',
    'content',
    'timestamp',
  ] as const;
  for (const f of strFields) {
    if (typeof b[f] !== 'string') return null;
  }
  // authorUsername is optional (older bot builds omit it); if present it must
  // be a string.
  if (b.authorUsername !== undefined && typeof b.authorUsername !== 'string') {
    return null;
  }
  if (!isStringArray(b.mentionedUserIds)) return null;
  // repoId / messageId must be non-empty (they become the Firestore path).
  if ((b.repoId as string).length === 0 || (b.messageId as string).length === 0) {
    return null;
  }
  return b as unknown as IngestPayload;
}

export const discordMessageIngest = onRequest(
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

    // 1. Validate payload shape.
    const payload = parsePayload(req.body);
    if (!payload) {
      res.status(400).send({ error: 'invalid payload' });
      return;
    }

    // Timestamp must parse to a valid date.
    const date = new Date(payload.timestamp);
    if (Number.isNaN(date.getTime())) {
      res.status(400).send({ error: 'invalid timestamp' });
      return;
    }

    // 2. Second-pass noise filter (defense-in-depth; forwarder runs the first pass).
    if (!shouldKeepMessage({ content: payload.content })) {
      res.status(200).send({ ok: true, skipped: 'filtered' });
      return;
    }

    // 3 + 4. Dedup + write atomically. `create()` fails if the doc already
    // exists, so messageId-as-doc-id doubles as the idempotency guard.
    const ref = db.doc(
      `apps/gitsync/repos/${payload.repoId}/discordMessages/${payload.messageId}`,
    );
    try {
      await ref.create({
        repoId: payload.repoId,
        channelId: payload.channelId,
        authorId: payload.authorId,
        authorName: payload.authorName,
        authorUsername: payload.authorUsername ?? payload.authorName,
        content: payload.content,
        mentionedUserIds: payload.mentionedUserIds,
        linkedTaskIds: [], // filled later by onDiscordMessageCreated
        timestamp: Timestamp.fromDate(date),
        ingestedAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      // gRPC ALREADY_EXISTS (code 6) → this message was already ingested.
      if ((e as { code?: number }).code === 6) {
        res.status(200).send({ ok: true, dup: true });
        return;
      }
      logger.error('discordMessageIngest write failed', {
        messageId: payload.messageId,
        error: String(e),
      });
      res.status(500).send({ error: 'write failed' });
      return;
    }

    logger.info('discordMessageIngest stored', { messageId: payload.messageId });
    res.status(200).send({ ok: true });
  },
);
