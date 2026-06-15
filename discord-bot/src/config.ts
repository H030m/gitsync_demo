// Loads + validates environment config for the GitSync bot.
//
// The bot has no Firestore credentials — it only talks to Cloud Functions over
// HTTP with the shared `x-ingest-secret`. Channel→repo mapping now lives in
// Firestore (set via /gitsync-listen → setRepoChannel) and is fetched at
// backfill time via claimDiscordFetch, so there is no static CHANNEL_REPO_MAP.
import 'dotenv/config';

export interface BotConfig {
  botToken: string;
  ingestSecret: string;
  // Cloud Function endpoints (all secret-auth onRequest, same asia-east1 base).
  ingestUrl: string; // discordMessageIngest
  claimUrl: string; // claimDiscordFetch
  completeUrl: string; // completeDiscordFetch
  setRepoChannelUrl: string; // setRepoChannel
  editDigestUrl: string; // botEditDigest
  // Backfill poll interval in milliseconds.
  pollIntervalMs: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value === 'REPLACE_ME') {
    throw new Error(`Missing required env var: ${name} (see .env.example)`);
  }
  return value;
}

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_PROJECT_ID = 'gitsync-645b3';
const REGION = 'asia-east1';

// Resolves the Cloud Functions base URL from a single `TARGET` switch, so the
// bot and the Flutter app (AppConfig.TARGET) flip between cloud and emulator
// together. An explicit FUNCTIONS_BASE_URL overrides everything (escape hatch).
//   TARGET=cloud     (default) → https://<region>-<projectId>.cloudfunctions.net
//   TARGET=emulator            → http://127.0.0.1:5001/<projectId>/<region>
function resolveBaseUrl(): string {
  const explicit = process.env.FUNCTIONS_BASE_URL;
  if (explicit && explicit !== 'REPLACE_ME') {
    return explicit.replace(/\/+$/, '');
  }
  const projectId = process.env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID;
  const target = (process.env.TARGET || 'cloud').toLowerCase();
  if (target === 'emulator') {
    return `http://127.0.0.1:5001/${projectId}/${REGION}`;
  }
  return `https://${REGION}-${projectId}.cloudfunctions.net`;
}

export function loadConfig(): BotConfig {
  // Single TARGET switch (cloud | emulator); per-endpoint URLs are derived by
  // appending the function name (matches the asia-east1 onRequest URL layout).
  const baseUrl = resolveBaseUrl();
  const endpoint = (name: string) => `${baseUrl}/${name}`;

  const rawInterval = process.env.POLL_INTERVAL_MS;
  const parsedInterval = rawInterval ? Number(rawInterval) : NaN;
  const pollIntervalMs =
    Number.isFinite(parsedInterval) && parsedInterval > 0
      ? parsedInterval
      : DEFAULT_POLL_INTERVAL_MS;

  return {
    botToken: required('DISCORD_BOT_TOKEN'),
    ingestSecret: required('DISCORD_INGEST_SECRET'),
    ingestUrl: endpoint('discordMessageIngest'),
    claimUrl: endpoint('claimDiscordFetch'),
    completeUrl: endpoint('completeDiscordFetch'),
    setRepoChannelUrl: endpoint('setRepoChannel'),
    editDigestUrl: endpoint('botEditDigest'),
    pollIntervalMs,
  };
}
