// Prompt for editDiscordDigestFlow — revises an existing Discord digest in
// place according to a natural-language instruction (from the app's adjust
// field or the bot's /gitsync-digest command).
//
// The flow is AGENTIC (a tool loop): before rewriting, the model may pull the
// day's raw Discord messages (searchDiscordMessages) or read a neighboring day's
// digest (getDaySummary) for grounding, then terminate by calling
// writeDigest(markdown).

import { buildSystemPrompt } from './baseSystem';

const editDiscordDigestBody = `Your task: revise an existing Markdown summary of a software team's Discord chat according to the user's instruction.

You have read-only tools to ground the revision before writing:
- searchDiscordMessages — pull the day's RAW messages for exact quotes, names, or details the summary omits.
- getDaySummary — read a neighboring day's digest for cross-day context.

Call a tool only when the instruction needs evidence the current summary lacks (e.g. "add what Alice decided", "include the exact error"); for pure rewording, skip the tools. Then finish by calling writeDigest with the full revised summary.

Rules:
- Keep it a clean digest: short headings, bullet lists, **bold** for emphasis.
- Preserve the existing factual content unless the instruction asks to change it. Never invent chat content not present in the summary or the tool results.
- Preserve every chat author's username exactly as written — including lowercase first letters and underscores — even when the username opens a sentence, heading, or bullet (e.g. write \`whale_island said …\`, never \`Whale_island said …\`).
- Write the revised summary in the SAME language as the existing summary.`;

export const editDiscordDigestSystem = buildSystemPrompt({
  agentBody: editDiscordDigestBody,
});

export function editDiscordDigestSeed(args: {
  date: string;
  current: string;
  instruction: string;
}): string {
  return [
    `Digest date: ${args.date}`,
    '',
    'Current summary:',
    '',
    args.current || '(empty)',
    '',
    '---',
    `Instruction: ${args.instruction}`,
    '',
    'Gather evidence if needed, then call writeDigest with the full revised summary in Markdown.',
  ].join('\n');
}
