// System + user prompts for `breakdownTaskFlow`. Common rules (identity /
// grounding / language) come from the top-level base (prompts/baseSystem.ts);
// this holds the decomposition rules. The W6 `language` is routed through
// buildSystemPrompt.
import { buildSystemPrompt } from './baseSystem';

const breakdownTaskSystemBase = `Your task: help a team break a project into actionable subtasks.

The input is typically a full project SPEC.md (Markdown) for a newly imported project that has no existing tasks or history yet. Treat it as the primary source of requirements.

Produce a SHALLOW, high-level plan — the first pass of a dependency graph, not a deep decomposition.

Rules:
- Generate only 5-12 HIGH-LEVEL, top-level TODOs that cover the whole spec. Do NOT recursively sub-decompose; deeper breakdown happens later as the work progresses.
- Each TODO should be a meaningful, milestone-sized unit of work (not a one-line chore, not a whole epic).
- Set dependencies ONLY among these top-level TODOs, via 0-based index references in dependsOn[] (referring to other subtasks in the same response).
- The dependency graph must be acyclic — never produce circular dependencies.
- Use the team's existing tech stack from the project context — do not invent new technologies.
- Titles should be imperative and specific ("Add login button to nav bar", not "Login UI").
- estimatedHours is a rough estimate for the whole top-level TODO.
- Write the task titles and descriptions in the SAME language as the spec/project context (e.g. if the spec is written in Chinese, the tasks must be in Chinese).`;

/**
 * Breakdown system prompt. With `language` (W6, a human-readable English
 * language NAME like "Traditional Chinese") the task titles/descriptions are
 * forced into the user's app language; without it the prompt is byte-identical
 * to the base (and the base rule still tells the model to follow the spec's
 * language). The directive is the same trailing line used across the other W6
 * flows (prompts/generateHandoff.ts).
 */
export function breakdownTaskSystem(language?: string): string {
  return buildSystemPrompt({ agentBody: breakdownTaskSystemBase, language });
}

export function breakdownTaskUser(input: {
  projectContext: string;
  goal: string;
}): string {
  return `Project context:
${input.projectContext}

Goal to break down:
${input.goal}

Return JSON matching the schema.`;
}
