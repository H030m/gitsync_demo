// System + user prompts for the rolling project-brief merge (W3a).
//
// One MODELS.fast call at the end of summarizeDayFlow re-summarizes the current
// brief together with today's daily report into an updated brief. The whole
// point of the merge is that the brief stays SMALL and DURABLE over time, so the
// prompt is dominated by anti-bloat / eviction rules (one of the three growth
// guards; the other two are the 500-word cap below and the deterministic
// MAX_BRIEF_CHARS truncation in tools/projectBrief.ts).
//
// Keep the system prompt a stable string so OpenAI's automatic prompt caching
// applies across daily merges. Common rules (identity / grounding) come from the
// top-level base (prompts/baseSystem.ts).
import { buildSystemPrompt } from './baseSystem';

const projectBriefMergeBody = `Your task: maintain a SINGLE living "project brief" for this repo — the durable knowledge a new teammate (or an AI agent) needs to act well on this project. You are given the CURRENT brief and the LATEST daily report. Produce the UPDATED brief.

KEEP (these are the brief's whole purpose):
- Architecture decisions and the reasoning behind them.
- Conventions / patterns the team follows (naming, testing, branch flow, idempotency rules…).
- Recurring or unresolved blockers, and known sharp edges / gotchas.
- Stable tech choices (frameworks, services, model tiers).

EVICT (actively remove — the brief is not a changelog):
- Day-specific activity ("today we merged 3 PRs") — that lives in daily reports, not here.
- Anything the latest report shows is now resolved, reverted, or obsolete.
- Duplicates and near-duplicates — merge them into one crisp statement.

HARD RULES:
- Output ONLY the brief markdown. No preamble, no "here is the updated brief".
- ABSOLUTE MAXIMUM 500 words. If you would exceed it, drop the least-durable, oldest, or most-specific lines until you fit. Brevity beats completeness.
- Do NOT invent facts. Every line must be grounded in the current brief or the latest report. When unsure whether something is durable, leave it OUT.
- If the latest report adds nothing durable, return the current brief essentially unchanged.
- Prefer terse bullet points grouped under short headings.`;

export const projectBriefMergeSystem = buildSystemPrompt({
  agentBody: projectBriefMergeBody,
});

export function projectBriefMergeUser(input: {
  oldBrief: string;
  report: string;
}): string {
  return `CURRENT PROJECT BRIEF (empty if this is the first report):
${input.oldBrief.trim() || '(none yet)'}

LATEST DAILY REPORT:
${input.report}

Return the updated project brief.`;
}
