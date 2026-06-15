import type { DayCommit, DayTask } from '../tools/dailyIntel';
import { buildSystemPrompt } from './baseSystem';

// Agent-specific body only. The common identity / grounding / no-fluff / language
// rules come from the top-level base (prompts/baseSystem.ts).
const summarizeDayBody = `Your task: turn a period's raw activity (commits, completed tasks, Discord discussion) into a short, useful report for the whole team. The period may be a single day or a multi-day range; the context states it.

You have tools:
- listRangeDigests(): per-day AI digests of the period's Discord chat (for blockers/decisions). Cheap — prefer this.
- listRangeDiscordMessages(): the period's raw Discord messages. Expensive — only when digests are missing.
- searchPastCommits(query): ground a theme in repo history when needed.
- finalizeReport(...): submit the finished report. Call it exactly once when done.

Workflow:
1. Read the period context you are given. To find blockers/decisions, call listRangeDigests first (fall back to listRangeDiscordMessages only if it returns nothing useful).
2. Group the commits into a few meaningful THEMES (e.g. "Auth", "Daily report UI"), each with a one-line plain summary and the number of commits it covers. This is the commit-message rollup developers rely on.
3. Then call finalizeReport with: a 2-3 sentence plain-English summary (lead with the most important achievement), highlights (key wins), blockers (from chat or stuck work — empty if none), and the commit themes.

Report specifics: mention blockers honestly. Do NOT output per-member counts — the backend computes those.`;

/**
 * Daily-report narrative system prompt. With `language` (W6, an English
 * language NAME like "Traditional Chinese") the narrative fields the model
 * authors (summary / highlights / blockers / commit themes) are forced into
 * that language on an explicit regenerate; the deterministic counts and
 * contributions are computed in TS and stay language-neutral. Without it the
 * model mirrors the input language (base rule).
 */
export function summarizeDaySystemPrompt(language?: string): string {
  return buildSystemPrompt({ agentBody: summarizeDayBody, language });
}

// How many commit lines we inline into the prompt before truncating (a long
// range can hold hundreds — the agent still sees exact totals).
const CONTEXT_COMMIT_CAP = 200;

/** Compact, cache-friendly period context. Heavy/raw detail is pruned to keep
 *  the prompt bounded (AGENTIC_CONCEPTS §4). */
export function summarizeDayContext(args: {
  startDate: string;
  endDate: string;
  commits: DayCommit[];
  tasks: DayTask[];
}): string {
  const { startDate, endDate, commits, tasks } = args;

  const shown = commits.slice(0, CONTEXT_COMMIT_CAP);
  const commitLines = shown.length
    ? shown
        .map((c) => {
          const who = c.authorName || c.authorLogin || 'unknown';
          const line = c.aiSummary ? `${c.message} — ${c.aiSummary}` : c.message;
          return `- (${who}) ${line}`;
        })
        .join('\n')
    : '- (none)';
  const truncated =
    commits.length > shown.length
      ? `\n- (+${commits.length - shown.length} more commits not shown)`
      : '';

  const taskLines = tasks.length
    ? tasks.map((t) => `- ${t.title}`).join('\n')
    : '- (none)';

  const period =
    startDate === endDate ? `Date: ${startDate}` : `Period: ${startDate} ~ ${endDate}`;

  return [
    period,
    ``,
    `Commits in the period (${commits.length}):`,
    commitLines + truncated,
    ``,
    `Tasks completed in the period (${tasks.length}):`,
    taskLines,
  ].join('\n');
}
