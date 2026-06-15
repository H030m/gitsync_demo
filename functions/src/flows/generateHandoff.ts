// generateHandoffFlow — produces an AI handoff document for the engineer picking
// up `taskId`, grounded in the REAL project signals behind its now-finished
// prerequisites. See ARCHITECTURE.md §5.3 and prd.md (06-12-w1-agentic-handoff).
//
// Design: TWO-PHASE AGENTIC.
//   Phase 1 (drafting, gpt-4o): an OpenAI function-calling loop over read-only
//   tools (listRelatedCommits / getCommitDiff / searchDiscordMessages /
//   searchPastCommits / readRepoPlanningDocs / readTeamState) that the agent
//   drives itself, terminating in `draftHandoff(markdown)`.
//   Phase 2 (self-review, gpt-4o-mini): a reviewer scores the draft (1-5) against
//   the receiving task's acceptance criteria. score>=4 finalizes; score<4 (while
//   under the global round cap) re-injects the gaps as a user message into the
//   SAME Phase-1 thread and loops back to draft again.
//
// Bounded by global caps (TOTAL_ROUNDS_CAP / MAX_TOOL_CALLS) so it always
// converges. Result shape `{ handoffMarkdown, cached }` and cache semantics
// (force) are unchanged from the prior one-shot version: the auto trigger
// (force=false) skips when a handoffDoc exists; the manual callable (force=true)
// always regenerates. Best-effort: write-backs and review failures never block
// the handoff.
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { zodResponseFormat } from 'openai/helpers/zod';
import type OpenAI from 'openai';

import { db } from '../admin';
import { getOpenAI, MODELS } from '../config';
import { readTeamState } from '../tools/assignTools';
import { searchDiscordMessages } from '../tools/discordSearch';
import { searchPastCommits } from '../tools/dailyIntel';
import { readRepoPlanningDocs } from '../tools/repoDocs';
import { listRelatedCommits, getCommitDiff } from '../tools/handoffTools';
import { readProjectBrief, formatBriefForPrompt } from '../tools/projectBrief';
import {
  startRun,
  appendStep,
  finishRun,
  TRACE_LABELS,
} from '../tools/agentTrace';
import {
  generateHandoffSystemPrompt,
  generateHandoffSeedContext,
  handoffReviewSystemPrompt,
  handoffReviewContext,
  handoffGapsFeedback,
} from '../prompts/generateHandoff';
import { HandoffReviewSchema, type HandoffReview } from '../types';

export interface GenerateHandoffInput {
  repoId: string;
  /** The task being handed TO (its prerequisites just finished). */
  taskId: string;
  /** Regenerate even when the task already has a handoffDoc. */
  force?: boolean;
  /** Client-generated agent-trace doc id (manual callable only). The auto
   *  trigger has no client and omits it → the trace is a no-op (best-effort). */
  runId?: string;
  /**
   * W6: optional human-readable English language NAME (e.g. "Traditional
   * Chinese", "English") that forces the handoff output into the user's app
   * language on an explicit regenerate. Threaded into BOTH the Phase-1 drafting
   * prompt and the Phase-2 reviewer prompt. Absent/empty → byte-identical
   * prompts to before (the auto trigger never sends it). Independent of `force`.
   */
  language?: string;
}

export interface GenerateHandoffResult {
  handoffMarkdown: string;
  cached: boolean;
}

// ---- Global loop caps (prd "The loop design") ------------------------------
/** Max Phase-1 model turns, across all review-retries; hitting it forces a draft. */
const TOTAL_ROUNDS_CAP = 5;
/** Max total tool calls (cost guard); hitting it forces a draft next turn. */
const MAX_TOOL_CALLS = 12;
/** Reviewer pass threshold — score >= this finalizes the draft. */
const REVIEW_PASS_SCORE = 4;
/**
 * Absolute hard ceiling on Phase-1 model turns — a safety net above
 * TOTAL_ROUNDS_CAP in case the model keeps returning no tool call even under a
 * forced `tool_choice` (should never happen, but guarantees termination).
 */
const HARD_ROUND_CEILING = TOTAL_ROUNDS_CAP + 3;
/** How many discord snippets / past commits a tool result is trimmed to. */
const MAX_DISCORD_MESSAGES = 20;

// OpenAI tool schema for the Phase-1 drafting loop. `draftHandoff` ends it.
const PHASE1_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'listRelatedCommits',
      description:
        'List commits linked (via #N refs) to the given task ids — the ' +
        "prerequisites' real work. Returns sha/subject/author/filesChanged/" +
        'aiSummary. Call this first to see what landed.',
      parameters: {
        type: 'object',
        properties: {
          taskIds: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Task ids to gather commits for (defaults to this task + its ' +
              'prerequisites if omitted).',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getCommitDiff',
      description:
        'Fetch the unified diff (patch) of ONE commit by sha, truncated to ' +
        '~3000 tokens. Use sparingly — only for commits whose change you must ' +
        'understand to write the handoff. Returns per-file patches.',
      parameters: {
        type: 'object',
        properties: {
          sha: {
            type: 'string',
            description: 'Full or short commit sha from listRelatedCommits.',
          },
        },
        required: ['sha'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchDiscordMessages',
      description:
        "Semantic search the repo's Discord discussion for decisions, " +
        'blockers, follow-ups behind this work. Returns grouped message snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language topic.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchPastCommits',
      description:
        'Semantic search the whole repo commit history to ground a claim or ' +
        'find when something was last touched. Use sparingly.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', description: 'default 6' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'readRepoPlanningDocs',
      description:
        "Read the repo's in-repo planning context (.trellis tasks/prd, " +
        'AGENTS.md/CLAUDE.md, docs) to understand project conventions and ' +
        'what is already done. Cheap (cached).',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'readTeamState',
      description:
        'List repo members (name, githubLogin) so you can refer to people by ' +
        'real name in the handoff.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draftHandoff',
      description:
        'Submit your handoff document as GitHub-flavored markdown. Ends the ' +
        'drafting loop. Must follow the four-section format.',
      parameters: {
        type: 'object',
        properties: {
          markdown: {
            type: 'string',
            description: 'The full handoff markdown.',
          },
        },
        required: ['markdown'],
        additionalProperties: false,
      },
    },
  },
];

export async function generateHandoffFlow(
  input: GenerateHandoffInput,
): Promise<GenerateHandoffResult> {
  const { repoId, taskId, force = false, runId, language } = input;

  const taskRef = db.doc(`apps/gitsync/repos/${repoId}/tasks/${taskId}`);
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) {
    throw new HttpsError('not-found', 'task not found');
  }
  const task = taskSnap.data() ?? {};

  // Cache: don't regenerate unless asked (the auto trigger relies on this to
  // avoid redoing work every time another prerequisite lands).
  const existing = task.handoffDoc as string | undefined;
  if (existing && !force) {
    return { handoffMarkdown: existing, cached: true };
  }

  const dependsOn = (task.dependsOn as string[] | undefined) ?? [];
  const acceptanceCriteria =
    (task.acceptanceCriteria as string[] | undefined) ?? [];
  const taskTitle = (task.title as string | undefined) ?? '';
  const taskDescription = (task.description as string | undefined) ?? '';

  // ---- Seed context (minimal): the task + its prerequisites' title/status.
  // The agent retrieves commits/diffs/discussion/roster itself via tools.
  const prerequisites = (
    await Promise.all(
      dependsOn.map(async (id) => {
        try {
          const s = await db
            .doc(`apps/gitsync/repos/${repoId}/tasks/${id}`)
            .get();
          if (!s.exists) return null;
          const d = s.data() ?? {};
          return {
            title: (d.title as string | undefined) ?? '',
            status: (d.status as string | undefined) ?? '',
          };
        } catch {
          return null;
        }
      }),
    )
  ).filter((p): p is { title: string; status: string } => p !== null);

  // Default task-id set for listRelatedCommits when the agent omits taskIds.
  const defaultCommitTaskIds = [...dependsOn, taskId];

  // Best-effort agent-trace (no-op without a runId — e.g. the auto trigger).
  // Trace writes NEVER affect this flow's control flow or result.
  await startRun(repoId, runId, 'generateHandoff');

  const openai = getOpenAI();

  // ---- W3a project-brief prefix (stable, cache-friendly; empty brief → '' →
  // byte-identical seed message, zero behavior change) -----------------------
  const briefPrefix = formatBriefForPrompt(await readProjectBrief(repoId));

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: generateHandoffSystemPrompt(language) },
    {
      role: 'user',
      content: briefPrefix + generateHandoffSeedContext({
        task: {
          title: taskTitle,
          description: taskDescription,
          acceptanceCriteria,
        },
        prerequisites,
      }),
    },
  ];

  let totalRounds = 0;
  let toolCalls = 0;
  let retries = 0;
  let draft: string | null = null;
  let finalScore = 0;

  // ---- Outer state machine: Phase 1 (draft) ↔ Phase 2 (review) -------------
  // Bounded by TOTAL_ROUNDS_CAP / MAX_TOOL_CALLS so it always terminates.
  for (;;) {
    // ── Phase 1: drafting loop ──────────────────────────────────────────────
    while (draft === null) {
      if (totalRounds >= HARD_ROUND_CEILING) {
        throw new HttpsError('internal', 'handoff drafting did not converge');
      }
      const forceDraft =
        totalRounds >= TOTAL_ROUNDS_CAP - 1 || toolCalls >= MAX_TOOL_CALLS;

      logger.info('generateHandoff: phase1 round', {
        repoId,
        taskId,
        totalRounds,
        toolCalls,
        forceDraft,
      });

      const completion = await openai.chat.completions.create({
        model: MODELS.reasoning,
        messages,
        tools: PHASE1_TOOLS,
        tool_choice: forceDraft
          ? { type: 'function', function: { name: 'draftHandoff' } }
          : 'auto',
      });
      totalRounds++;

      const choice = completion.choices[0]?.message;
      if (!choice) {
        throw new HttpsError('internal', 'OpenAI returned no message');
      }
      messages.push(choice);

      const calls = choice.tool_calls ?? [];
      if (calls.length === 0) {
        // Model answered without a tool — nudge it to draft or call a tool.
        messages.push({
          role: 'user',
          content:
            'Call draftHandoff with your markdown, or a tool to gather evidence.',
        });
        continue;
      }

      // draftHandoff wins if present this turn (prd Q6: finalize precedence).
      const draftCall = calls.find(
        (c) => c.type === 'function' && c.function.name === 'draftHandoff',
      );
      if (draftCall && draftCall.type === 'function') {
        const args = safeParse(draftCall.function.arguments);
        draft = String(args.markdown ?? '').trim();
        // Answer every tool_call this turn so the thread stays well-formed.
        for (const c of calls) {
          messages.push({
            role: 'tool',
            tool_call_id: c.id,
            content: c.id === draftCall.id ? 'ok' : 'superseded by draftHandoff',
          });
        }
        break;
      }

      // Otherwise run the read tools in parallel and append their results.
      toolCalls += calls.length;
      const results = await Promise.all(
        calls.map(async (call) => {
          if (call.type !== 'function') {
            return { id: call.id, content: 'unsupported tool call' };
          }
          const content = await runReadTool(
            repoId,
            defaultCommitTaskIds,
            call.function.name,
            safeParse(call.function.arguments),
          );
          return { id: call.id, content };
        }),
      );
      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }

      // One batch trace write per Phase-1 tool round (best-effort, no-op
      // without a runId). Map each tool name to its English label.
      await appendStep(
        repoId,
        runId,
        calls.map((c) =>
          c.type === 'function'
            ? (TRACE_LABELS as Record<string, string>)[c.function.name] ?? c.function.name
            : '',
        ),
      );
    }

    if (!draft) {
      throw new HttpsError('internal', 'OpenAI returned an empty handoff');
    }

    // ── Phase 2: self-review (separate, short thread) ───────────────────────
    const review = await reviewDraft({
      draft,
      taskTitle,
      taskDescription,
      acceptanceCriteria,
      language,
    });
    finalScore = review.score;

    // Trace the review verdict (best-effort, no-op without a runId).
    await appendStep(repoId, runId, `Reviewing draft (score ${review.score}/5)…`);

    const capReached = totalRounds >= TOTAL_ROUNDS_CAP;
    if (review.score >= REVIEW_PASS_SCORE || capReached) {
      break; // finalize the current draft
    }

    // review-retry: re-inject gaps into the Phase-1 thread and draft again.
    retries++;
    logger.info('generateHandoff: review retry', {
      repoId,
      taskId,
      score: review.score,
      retries,
      totalRounds,
    });
    messages.push({
      role: 'user',
      content: handoffGapsFeedback(review.score, review.gaps),
    });
    draft = null;
  }

  // ---- Persist on the task doc (best-effort) -------------------------------
  try {
    await taskRef.update({
      handoffDoc: draft,
      handoffGeneratedAt: FieldValue.serverTimestamp(),
      handoffReview: {
        score: finalScore,
        rounds: totalRounds,
        generatedAt: FieldValue.serverTimestamp(),
      },
    });
  } catch (err) {
    logger.warn('generateHandoff: write-back failed (best-effort)', {
      repoId,
      taskId,
      err: String(err),
    });
  }

  // Close the agent-trace run (best-effort, no-op without a runId).
  await finishRun(repoId, runId, 'done');

  logger.info('generateHandoff: finalized', {
    repoId,
    taskId,
    totalRounds,
    finalScore,
    retries,
  });
  return { handoffMarkdown: draft, cached: false };
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Phase-2 reviewer: scores the draft against the task in a short, isolated
 * thread (not the Phase-1 messages, so the reviewer stays cheap and focused).
 * Best-effort: a parse failure / null result is treated as a PASS so a broken
 * reviewer never blocks the handoff (prd Q3).
 */
async function reviewDraft(args: {
  draft: string;
  taskTitle: string;
  taskDescription: string;
  acceptanceCriteria: string[];
  /** W6: forces the reviewer to expect (and not penalize) this language. */
  language?: string;
}): Promise<HandoffReview> {
  try {
    const completion = await getOpenAI().beta.chat.completions.parse({
      model: MODELS.fast,
      messages: [
        { role: 'system', content: handoffReviewSystemPrompt(args.language) },
        { role: 'user', content: handoffReviewContext(args) },
      ],
      response_format: zodResponseFormat(HandoffReviewSchema, 'handoffReview'),
    });
    const parsed =
      (completion.choices[0]?.message?.parsed as HandoffReview | null) ?? null;
    if (!parsed) {
      logger.warn('generateHandoff: reviewer returned no parse; treating as pass');
      return { score: REVIEW_PASS_SCORE, gaps: [] };
    }
    return parsed;
  } catch (err) {
    logger.warn('generateHandoff: reviewer failed; treating as pass', {
      err: String(err),
    });
    return { score: REVIEW_PASS_SCORE, gaps: [] };
  }
}

/** Execute a non-draft read tool, returning a JSON string for the model. */
async function runReadTool(
  repoId: string,
  defaultCommitTaskIds: string[],
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'listRelatedCommits': {
      const taskIds =
        Array.isArray(args.taskIds) && args.taskIds.length > 0
          ? (args.taskIds as unknown[]).map((t) => String(t))
          : defaultCommitTaskIds;
      return JSON.stringify(await listRelatedCommits(repoId, taskIds));
    }
    case 'getCommitDiff':
      return JSON.stringify(
        await getCommitDiff(repoId, String(args.sha ?? '')),
      );
    case 'searchDiscordMessages': {
      const snippets = await searchDiscordMessages(
        repoId,
        String(args.query ?? ''),
      );
      const flat = snippets
        .flatMap((s) => s.messages)
        .map((m) => ({ author: m.authorName, content: m.content }))
        .slice(0, MAX_DISCORD_MESSAGES);
      return JSON.stringify(flat);
    }
    case 'searchPastCommits':
      return JSON.stringify(
        await searchPastCommits(
          repoId,
          String(args.query ?? ''),
          typeof args.limit === 'number' ? args.limit : undefined,
        ),
      );
    case 'readRepoPlanningDocs':
      return JSON.stringify((await readRepoPlanningDocs(repoId)).content);
    case 'readTeamState':
      return JSON.stringify(
        (await readTeamState(repoId)).map((m) => ({
          name: m.name,
          githubLogin: m.githubLogin,
        })),
      );
    default:
      return `Error: unknown tool ${name}`;
  }
}

/** Parse a tool-call arguments JSON string, tolerating malformed input. */
function safeParse(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
