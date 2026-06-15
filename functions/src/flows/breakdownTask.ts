// breakdownTaskFlow — splits a goal into actionable subtasks using OpenAI
// structured outputs. Pre-generates Firestore taskIds before writing so we
// can translate the LLM's 0-based-index `dependsOn` into real taskIds in a
// single transaction.
//
// Detailed contract: ARCHITECTURE.md §5.1 + MEMORY.md 2026-05-26
// "dependsOn type contract".
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { zodResponseFormat } from 'openai/helpers/zod';

import { db } from '../admin';
import { getOpenAI, MODELS } from '../config';
import { breakdownTaskSystem, breakdownTaskUser } from '../prompts/breakdownTask';
import { readRepoPlanningDocs } from '../tools/repoDocs';
import { readProjectBrief, formatBriefForPrompt } from '../tools/projectBrief';
import { BreakdownOutputSchema, BreakdownOutput } from '../types';

export interface BreakdownTaskInput {
  repoId: string;
  goal: string;
  /** Firebase Auth UID of the requester, for `createdBy`. */
  requestedBy: string;
  /**
   * W6: optional human-readable English language NAME (e.g. "Traditional
   * Chinese") the client derives from the app locale. When set, the generated
   * task titles/descriptions are forced into that language; absent/empty → the
   * model follows the spec's own language (the base prompt rule).
   */
  language?: string;
}

export interface BreakdownTaskResult {
  /** Final subtasks with REAL `taskId` strings (already written to Firestore). */
  subtasks: Array<{
    id: string;
    title: string;
    description: string;
    dependsOn: string[];
    estimatedHours: number;
  }>;
}

export async function breakdownTaskFlow(
  input: BreakdownTaskInput,
): Promise<BreakdownTaskResult> {
  const { repoId, goal, requestedBy, language } = input;

  // ---- Step 1: fetchProjectContext (Firestore only, NO GitHub) -------------
  // Context = the pasted SPEC.md (`goal`) + light repo info (name/desc).
  logger.info('Step 1: fetch project context', { repoId });
  const repoRef = db.doc(`apps/gitsync/repos/${repoId}`);
  const repoSnap = await repoRef.get();
  if (!repoSnap.exists) {
    throw new HttpsError('not-found', `repo ${repoId} not found`);
  }
  const repo = repoSnap.data() ?? {};

  // Best-effort: pull the repo's in-repo planning docs (.trellis / AGENTS.md /
  // CLAUDE.md / .claude / docs) so the breakdown knows what work already exists
  // instead of re-decomposing it. An empty result (no docs, no token) leaves the
  // "newly imported project" framing unchanged. Never throws.
  const repoDocs = await readRepoPlanningDocs(repoId);
  const hasDocs = repoDocs.content.trim().length > 0;

  // Best-effort: prepend the accumulated project brief as a stable, cache-friendly
  // prefix (empty brief → '' → byte-identical prompt).
  const briefPrefix = formatBriefForPrompt(await readProjectBrief(repoId));

  const projectContext = [
    briefPrefix || undefined,
    hasDocs ? repoDocs.content : undefined,
    `Repository: ${repo.name ?? repoId}`,
    repo.description ? `Description: ${repo.description}` : undefined,
    hasDocs
      ? undefined
      : 'This is a newly imported project — there are no existing tasks yet.',
  ]
    .filter(Boolean)
    .join('\n');

  // ---- Step 2: structured-output breakdown via OpenAI ----------------------
  logger.info('Step 2: call OpenAI for breakdown', { repoId });
  const openai = getOpenAI();
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: breakdownTaskSystem(language) },
    { role: 'user', content: breakdownTaskUser({ projectContext, goal }) },
  ];

  const completion = await openai.beta.chat.completions.parse({
    model: MODELS.reasoning,
    messages,
    response_format: zodResponseFormat(BreakdownOutputSchema, 'breakdown'),
  });
  let parsed: BreakdownOutput | null =
    (completion.choices[0]?.message?.parsed as BreakdownOutput | null) ?? null;
  if (!parsed) {
    throw new HttpsError(
      'internal',
      'AI did not return a valid breakdown (refused or empty).',
    );
  }

  // ---- Step 3 / 3b: cycle detection + single re-prompt ---------------------
  let cycles = detectCycles(parsed.subtasks);
  if (cycles.length > 0) {
    logger.warn('Step 3: cycle detected, re-prompting once', { repoId, cycles });
    messages.push({
      role: 'assistant',
      content: JSON.stringify(parsed),
    });
    messages.push({
      role: 'user',
      content:
        'Your previous response contained circular dependencies among these ' +
        `subtask indices: ${JSON.stringify(cycles)}. ` +
        'Regenerate the breakdown so that dependsOn forms a directed acyclic ' +
        'graph (no cycles). Return JSON matching the schema.',
    });

    const retry = await openai.beta.chat.completions.parse({
      model: MODELS.reasoning,
      messages,
      response_format: zodResponseFormat(BreakdownOutputSchema, 'breakdown'),
    });
    parsed = (retry.choices[0]?.message?.parsed as BreakdownOutput | null) ?? null;
    if (!parsed) {
      throw new HttpsError(
        'internal',
        'AI did not return a valid breakdown on re-prompt.',
      );
    }
    cycles = detectCycles(parsed.subtasks);
    if (cycles.length > 0) {
      throw new HttpsError('internal', 'AI produced cyclic dependencies twice');
    }
  }

  const subtasks = parsed.subtasks;

  // ---- Step 4: pre-generate Firestore doc IDs ------------------------------
  const tasksCol = db.collection(`apps/gitsync/repos/${repoId}/tasks`);
  const ids = subtasks.map(() => tasksCol.doc().id);

  // ---- Step 5: translate dependsOn 0-based indices → real taskIds ----------
  const dependsOnIds: string[][] = subtasks.map((s) =>
    s.dependsOn
      .filter((idx) => idx >= 0 && idx < ids.length)
      .map((idx) => ids[idx]),
  );

  // ---- Step 6: transactional batch write -----------------------------------
  // NOTE: the flow does NOT touch `isBreakingDown` — the handler owns that lock
  // and releases it in `finally`.
  logger.info('Step 6: writing task docs', { repoId, count: subtasks.length });
  const now = FieldValue.serverTimestamp();
  const batch = db.batch();
  subtasks.forEach((s, i) => {
    batch.set(tasksCol.doc(ids[i]), {
      title: s.title,
      description: s.description,
      status: 'todo',
      assigneeId: null,
      dependsOn: dependsOnIds[i],
      githubIssueNumber: null,
      linkedPRNumbers: [],
      acceptanceCriteria: [],
      handoffDoc: null,
      source: 'ai_breakdown',
      parentTaskId: null,
      createdBy: requestedBy,
      createdAt: now,
      updatedAt: now,
      estimatedHours: s.estimatedHours,
    });
  });
  await batch.commit();

  return {
    subtasks: subtasks.map((s, i) => ({
      id: ids[i],
      title: s.title,
      description: s.description,
      dependsOn: dependsOnIds[i],
      estimatedHours: s.estimatedHours,
    })),
  };
}

// ---- Helpers (exported so tests can unit-test them in isolation) -----------

/**
 * Returns the indices of every cycle in the dependency graph (DFS).
 * Empty array = no cycles.
 */
export function detectCycles(
  subtasks: Array<{ dependsOn: number[] }>,
): number[][] {
  const cycles: number[][] = [];
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Array<number>(subtasks.length).fill(WHITE);
  const stack: number[] = [];

  function dfs(i: number) {
    color[i] = GRAY;
    stack.push(i);
    for (const dep of subtasks[i].dependsOn) {
      if (dep < 0 || dep >= subtasks.length) continue;
      if (color[dep] === GRAY) {
        cycles.push([...stack.slice(stack.indexOf(dep)), dep]);
      } else if (color[dep] === WHITE) {
        dfs(dep);
      }
    }
    color[i] = BLACK;
    stack.pop();
  }

  for (let i = 0; i < subtasks.length; i++) {
    if (color[i] === WHITE) dfs(i);
  }
  return cycles;
}

// Re-exports kept here so handler files have one short import:
export { BreakdownOutputSchema, getOpenAI, MODELS, breakdownTaskSystem, breakdownTaskUser, zodResponseFormat, db, logger };
export type { BreakdownOutput };
