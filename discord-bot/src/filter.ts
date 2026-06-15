// First-pass noise filter, run inside the forwarder before POSTing to the
// ingest endpoint (drops obvious junk so it never costs a Cloud Function call).
//
// ⚠️ MUST stay in sync with `functions/src/tools/discordFilter.ts` — these rules
// are intentionally duplicated and maintained in parallel (the ingest function
// runs the same check as a second pass). See MEMORY.md 2026-05-26 "Discord
// messages filtered at both forwarder and ingest function".

const NOISE_PATTERNS: RegExp[] = [
  /^(haha+|呵+|哈+|lol|lmao|gg|wtf|wow|ohh+)$/i,
  /^(ok|okay|好|收到|了解|knows|got it|noted|sure|thanks?|thx|謝謝|感謝)\W*$/i,
  /^[+\-]\s*1$/,
  /^https?:\/\/\S+\s*$/i,
  /^[\s\p{Emoji}\p{Emoji_Modifier}\p{Emoji_Component}]+$/u,
];

export interface RawDiscordPayload {
  isBot?: boolean;
  content?: string;
  attachmentCount?: number;
}

export function shouldKeepMessage(msg: RawDiscordPayload): boolean {
  if (msg.isBot) return false;
  const content = (msg.content ?? '').trim();
  if (content.length === 0 && (msg.attachmentCount ?? 0) > 0) return false;
  if (content.length < 5) return false;
  if (NOISE_PATTERNS.some((re) => re.test(content))) return false;
  return true;
}
