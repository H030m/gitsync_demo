// judgeTaskCompletion — an AI judge that decides whether a single commit
// actually COMPLETES a given task (semantic judgement, not closing-keyword
// matching). Used by the `onCommitCompletesTask` trigger.
//
// Input is intentionally cheap (no GitHub API / diff fetch, 06-14 D1): the
// commit message + changed file names + the task's title/description/
// acceptanceCriteria. We make ONE single completion in JSON mode (the
// single-completion shape required for trigger-driven best-effort flows —
// bounded latency/cost, no multi-round loop that could stall the trigger).
//
// Best-effort (06-14): on ANY error or unparseable output we return
// `{ complete: false, confidence: 0, reason: '<err>' }` and NEVER throw, so a
// flaky judge can never abort the trigger or change task state by accident.
import { logger } from 'firebase-functions/v2';

import { getOpenAI, MODELS } from '../config';

export interface TaskContext {
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface CommitContext {
  message: string;
  filesChanged: string[];
}

export interface CompletionJudgement {
  complete: boolean;
  confidence: number;
  reason: string;
}

const SYSTEM_PROMPT =
  'You are a senior engineer reviewing whether a single git commit actually ' +
  'COMPLETES a task. You are given the task (title, description, acceptance ' +
  'criteria) and the commit (message + list of changed file paths). You do NOT ' +
  'have the diff — judge from the message and the files touched. Decide whether ' +
  'this commit, on its own, fully completes the task. Be conservative: partial ' +
  'progress, a WIP commit, or a commit that merely references the task is NOT ' +
  'complete. Respond with ONLY a JSON object of the exact shape ' +
  '{"complete": boolean, "confidence": number, "reason": string} where ' +
  'confidence is your certainty in [0, 1] and reason is one short sentence.';

function buildUserPrompt(task: TaskContext, commit: CommitContext): string {
  const ac =
    task.acceptanceCriteria.length > 0
      ? task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
      : '(none provided)';
  const files =
    commit.filesChanged.length > 0
      ? commit.filesChanged.map((f) => `- ${f}`).join('\n')
      : '(none reported)';
  return (
    `TASK TITLE:\n${task.title || '(none)'}\n\n` +
    `TASK DESCRIPTION:\n${task.description || '(none)'}\n\n` +
    `ACCEPTANCE CRITERIA:\n${ac}\n\n` +
    `COMMIT MESSAGE:\n${commit.message || '(none)'}\n\n` +
    `CHANGED FILES:\n${files}`
  );
}

function clampConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Ask the model whether `commit` completes `task`. Never throws — degrades to
 * `{ complete: false, confidence: 0, reason }` on any failure.
 */
export async function judgeTaskCompletion(
  task: TaskContext,
  commit: CommitContext,
): Promise<CompletionJudgement> {
  try {
    const completion = await getOpenAI().chat.completions.create({
      model: MODELS.fast,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(task, commit) },
      ],
    });
    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) {
      return { complete: false, confidence: 0, reason: 'empty model response' };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      complete: parsed.complete === true,
      confidence: clampConfidence(parsed.confidence),
      reason:
        typeof parsed.reason === 'string' ? parsed.reason : '(no reason given)',
    };
  } catch (err) {
    // Best-effort: a failed/unparseable judge must not change task state.
    logger.warn('judgeTaskCompletion: failed (defaulting to not-complete)', {
      err: String(err),
    });
    return { complete: false, confidence: 0, reason: String(err) };
  }
}
