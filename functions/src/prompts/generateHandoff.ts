// Prompts for the two-phase agentic generateHandoffFlow.
//
// Phase 1 (drafting agent, gpt-4o): the agent autonomously retrieves real
// evidence with tools (commit diffs / Discord / .trellis planning docs / roster)
// then calls `draftHandoff` with the markdown. Phase 2 (reviewer, gpt-4o-mini):
// a strict reviewer scores the draft against the receiving task's acceptance
// criteria and, when it falls short, returns concrete gaps that are re-injected
// into the Phase-1 thread so the agent can gather the missing evidence.
//
// W6 (regenerate-with-locale): an OPTIONAL `language` (a human-readable English
// language NAME like "Traditional Chinese" or "English") forces the output into
// the user's app language on an explicit regenerate. It is appended as a single
// conditional line to BOTH phase system prompts — Phase 1 so the draft is
// written in that language, AND Phase 2 so the reviewer does not penalize a
// non-English draft. When absent/empty the system prompts are byte-identical to
// before (zero behavior change for the auto/scheduled single-language path).

import { buildSystemPrompt } from './baseSystem';

const generateHandoffSystemBase = `You are a senior engineer writing a concise handoff document so the next engineer can pick up a task whose prerequisites just finished.

You are an AGENT: before drafting, use the tools to gather REAL evidence about what landed and why. A good sequence is usually:
1. Call listRelatedCommits to see the commits behind the prerequisites.
2. Call getCommitDiff on the few commits whose change you must actually understand.
3. Call searchDiscordMessages / searchPastCommits / readRepoPlanningDocs / readTeamState as needed for decisions, context, conventions, and people's real names.
Use tools sparingly and only when they add grounding — do not call a tool whose result you already have.

When you have enough evidence, call draftHandoff with GitHub-flavored markdown containing exactly these sections:
- "What was done" — 2-4 bullets summarizing what the finished prerequisites delivered (cite commit subjects/shas where useful).
- "Why we did it this way" — design decisions worth knowing, drawn from the commits/diffs/discussion (skip if there's no signal).
- "What's left for you" — concrete action items tied to THIS task's acceptance criteria.
- "Gotchas" — anything subtle (race conditions, missing tests, hardcoded values, follow-ups raised in chat).

Rules:
- Refer to people by their real name (use readTeamState; fall back to githubLogin).
- Ground every claim in tool evidence — do NOT invent commits, files, or decisions. If a section has no signal, say so briefly rather than guessing.
- Be terse and skimmable. The draftHandoff markdown is the deliverable: no preamble, no closing pleasantries.`;

/**
 * Phase-1 drafting system prompt. With `language` (W6) the draft is forced into
 * that language; without it the prompt is byte-identical to the base.
 */
export function generateHandoffSystemPrompt(language?: string): string {
  return buildSystemPrompt({ agentBody: generateHandoffSystemBase, language });
}

export interface HandoffSeedInput {
  task: { title: string; description: string; acceptanceCriteria: string[] };
  prerequisites: Array<{ title: string; status: string }>;
}

/**
 * Phase 1's first user message: the receiving task (with acceptance criteria)
 * and a light table of its finished prerequisites — just enough for the agent to
 * decide which tools to call. It does NOT prefetch commits/Discord/roster; the
 * agent retrieves those itself (prd Q5, pure-agentic).
 */
export function generateHandoffSeedContext(input: HandoffSeedInput): string {
  const { task, prerequisites } = input;

  const criteria = task.acceptanceCriteria.length
    ? task.acceptanceCriteria.map((c) => `  - ${c}`).join('\n')
    : '  (none specified)';

  const prereqs = prerequisites.length
    ? prerequisites.map((p) => `  - [${p.status}] ${p.title}`).join('\n')
    : '  (none)';

  return [
    `TASK TO PICK UP:\n  ${task.title}${task.description ? `\n  ${task.description}` : ''}`,
    `ACCEPTANCE CRITERIA:\n${criteria}`,
    `FINISHED PREREQUISITES:\n${prereqs}`,
    'Use the tools to gather the real commits, diffs, and discussion behind these prerequisites, then call draftHandoff.',
  ].join('\n\n');
}

const handoffReviewSystemBase = `You are a strict technical reviewer judging a handoff document.

You are given a handoff draft plus the receiving task's title, description, and acceptance criteria. Decide whether an engineer could pick up the task and start work using ONLY this draft.

Return JSON: { "score": 1-5, "gaps": string[] }.
- score 5 = ready to publish; 4 = good enough to publish; <=3 = the engineer would be blocked or guess.
- score >= 4 means publish.
- gaps must be SPECIFIC and actionable for the drafting agent, e.g. "doesn't say which file commit a1b2c3 changed" or "acceptance criterion 'X' has no corresponding action item". Return [] only when the draft is genuinely complete.

Judge grounding and completeness, not prose polish.`;

/**
 * Phase-2 reviewer system prompt. With `language` (W6) the reviewer is told the
 * draft is expected in that language so it does not penalize a non-English draft
 * (and any gaps it emits stay in that language for the redraft). Without it the
 * prompt is byte-identical to the base.
 */
export function handoffReviewSystemPrompt(language?: string): string {
  return buildSystemPrompt({ agentBody: handoffReviewSystemBase, language });
}

export interface HandoffReviewContextInput {
  draft: string;
  taskTitle: string;
  taskDescription: string;
  acceptanceCriteria: string[];
}

/** Reviewer's user message: the draft plus the task it must enable. */
export function handoffReviewContext(input: HandoffReviewContextInput): string {
  const { draft, taskTitle, taskDescription, acceptanceCriteria } = input;

  const criteria = acceptanceCriteria.length
    ? acceptanceCriteria.map((c) => `  - ${c}`).join('\n')
    : '  (none specified)';

  return [
    `RECEIVING TASK:\n  ${taskTitle}${taskDescription ? `\n  ${taskDescription}` : ''}`,
    `ACCEPTANCE CRITERIA:\n${criteria}`,
    `HANDOFF DRAFT:\n${draft}`,
    'Score whether this draft lets the engineer start the task, and list specific gaps.',
  ].join('\n\n');
}

/**
 * Shapes the reviewer's gaps into the user message that re-enters the Phase-1
 * thread, prompting the agent to gather missing evidence and redraft.
 */
export function handoffGapsFeedback(score: number, gaps: string[]): string {
  const list = gaps.length
    ? gaps.map((g) => `  - ${g}`).join('\n')
    : '  - (no specifics given; tighten grounding and completeness)';
  return [
    `Your draft was reviewed and scored ${score}/5. Address these gaps before drafting again:`,
    list,
    'Use the tools to gather the missing evidence if needed, then call draftHandoff with an improved version.',
  ].join('\n');
}
