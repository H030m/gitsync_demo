// OpenAI client + secret declarations.
//
// `defineSecret` registers a secret with Firebase. To make a callable / trigger
// receive the value at runtime, list the secret in its `secrets:` option (e.g.
// `onCall({ region: REGION, secrets: [openaiKey] }, handler)`).
//
// Local emulator picks up secrets from `functions/.secret.local`.
// Production reads them from Google Secret Manager.
import { defineSecret } from 'firebase-functions/params';
import OpenAI from 'openai';

export const openaiKey = defineSecret('OPENAI_API_KEY');
export const discordIngestSecret = defineSecret('DISCORD_INGEST_SECRET');

let _openai: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (_openai) return _openai;
  _openai = new OpenAI({ apiKey: openaiKey.value() });
  return _openai;
}

export const MODELS = {
  reasoning: 'gpt-4o',
  fast: 'gpt-4o-mini',
  embedding: 'text-embedding-3-small',
} as const;

export const EMBEDDING_DIM = 1536;
