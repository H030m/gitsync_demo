// assignTaskFlow — agentic OpenAI function-calling loop that picks the best
// assignee for a task, then auto-applies the assignment (writes
// `tasks/{taskId}.assigneeId` + rebalances member `activeIssueCount`). See
// ARCHITECTURE.md §5.2 and prd.md (06-02-assign-task-flow).
//
// This flow uses FUNCTION CALLING (`chat.completions.create` with `tools` +
// `tool_choice: 'auto'`), NOT the `.beta.chat.completions.parse` structured
// output path used by breakdownTask.
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import type OpenAI from 'openai';

import { getOpenAI, MODELS } from '../config';
import { assignTaskSystem } from '../prompts/assignTask';
import {
  readTeamState,
  searchMemberCommits,
  getTaskDependents,
  mergeLearnedTags,
} from '../tools/assignTools';
import { readProjectBrief, formatBriefForPrompt } from '../tools/projectBrief';
import { applyAssignment } from '../tools/taskStatus';
import { db } from '../admin';

export interface AssignTaskInput {
  repoId: string;
  taskId: string;
}

export interface AssignTaskResult {
  assigneeId: string;
  reasoning: string;
}

const MAX_ROUNDS = 5;

// OpenAI tool schema for the agentic loop. `finalizeAssignment` ends the loop.
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'readTeamState',
      description:
        'List all members of the repo with workload (activeIssueCount, ' +
        'lastActiveAt), identity (name, githubLogin, discordUserId) and ' +
        'expertiseTags. Call this first.',
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
      name: 'searchMemberCommits',
      description:
        "Semantic search over a single member's past commit messages to gauge " +
        'whether they have relevant experience for the task topic.',
      parameters: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: 'The member userId.' },
          query: {
            type: 'string',
            description: 'Natural-language topic to search their commits for.',
          },
        },
        required: ['memberId', 'query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getTaskDependents',
      description:
        'List downstream tasks blocked by this task (those whose dependsOn ' +
        'contains it). Prefer assignees who unblock more work.',
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
      name: 'finalizeAssignment',
      description:
        'Commit your final decision. Ends the loop. assigneeId MUST be one of ' +
        'the member userIds returned by readTeamState.',
      parameters: {
        type: 'object',
        properties: {
          assigneeId: { type: 'string' },
          reason: {
            type: 'string',
            description: 'Concise justification for the choice.',
          },
          learnedTags: {
            type: 'array',
            items: { type: 'string' },
            description:
              "0-4 short lowercase skill tags (e.g. 'frontend','auth','ml') that " +
              'the EVIDENCE YOU ACTUALLY RETRIEVED shows this assignee has. Derive ' +
              'ONLY from commits among tools you called this run — do NOT guess from ' +
              'the task title. Omit or [] if you have no evidence.',
          },
        },
        required: ['assigneeId', 'reason'],
        additionalProperties: false,
      },
    },
  },
];

export async function assignTaskFlow(
  input: AssignTaskInput,
): Promise<AssignTaskResult> {
  const { repoId, taskId } = input;

  // ---- Pre-checks (NO OpenAI yet) -----------------------------------------
  logger.info('assignTaskFlow: pre-checks', { repoId, taskId });

  const taskSnap = await db
    .doc(`apps/gitsync/repos/${repoId}/tasks/${taskId}`)
    .get();
  if (!taskSnap.exists) {
    throw new HttpsError('not-found', `task ${taskId} not found`);
  }
  const task = taskSnap.data() ?? {};
  if (task.status === 'done') {
    throw new HttpsError('failed-precondition', '任務已完成，無法分派');
  }

  const members = await readTeamState(repoId);
  if (members.length === 0) {
    throw new HttpsError('failed-precondition', '沒有可分派的成員');
  }
  const memberIds = new Set(members.map((m) => m.userId));

  // ---- Single-member shortcut: skip OpenAI entirely ------------------------
  if (members.length === 1) {
    const only = members[0];
    logger.info('assignTaskFlow: single-member shortcut', {
      repoId,
      taskId,
      assigneeId: only.userId,
    });
    await applyAssignment(repoId, taskId, only.userId);
    return {
      assigneeId: only.userId,
      reasoning: '只有一位成員，直接分派。',
    };
  }

  // Best-effort: the accumulated project brief, prepended (as a stable prefix)
  // to the user message — the system prompt stays byte-identical for caching.
  const briefPrefix = formatBriefForPrompt(await readProjectBrief(repoId));

  // ---- Agentic function-calling loop (>=2 members) -------------------------
  const openai = getOpenAI();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: assignTaskSystem },
    {
      role: 'user',
      content: briefPrefix + buildTaskBrief(repoId, taskId, task, members),
    },
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    logger.info('assignTaskFlow: agentic round', { repoId, taskId, round });

    const completion = await openai.chat.completions.create({
      model: MODELS.reasoning,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
    });

    const choice = completion.choices[0]?.message;
    if (!choice) {
      throw new HttpsError('internal', 'OpenAI returned no message');
    }
    messages.push(choice);

    const toolCalls = choice.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // Model answered without calling a tool — nudge it to finalize, retry.
      messages.push({
        role: 'user',
        content:
          'You must call finalizeAssignment with your chosen assigneeId.',
      });
      continue;
    }

    // Check for a finalize call first; if present we end after applying it.
    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      if (call.function.name === 'finalizeAssignment') {
        const args = safeParse(call.function.arguments);
        const assigneeId = String(args.assigneeId ?? '');
        const reason = String(args.reason ?? '');
        if (!memberIds.has(assigneeId)) {
          // Invalid choice — feed back the error and let the model retry.
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `Error: ${assigneeId} is not a member of this repo. ` +
              `Valid assigneeIds: ${[...memberIds].join(', ')}`,
          });
          continue;
        }
        logger.info('assignTaskFlow: finalize', { repoId, taskId, assigneeId });
        await applyAssignment(repoId, taskId, assigneeId);
        // W3b: best-effort learn the agent's tags into the assignee's expertise.
        // Separate from the applyAssignment transaction (different doc, best-effort).
        const learnedTags = Array.isArray(args.learnedTags)
          ? args.learnedTags.map((t) => String(t))
          : [];
        if (learnedTags.length > 0) {
          await mergeLearnedTags(repoId, assigneeId, learnedTags);
        }
        return { assigneeId, reasoning: reason };
      }
    }

    // No (valid) finalize this round — execute the read tools in parallel and
    // append each result so the next round can reason over it.
    const results = await Promise.all(
      toolCalls.map(async (call) => {
        if (call.type !== 'function') {
          return { tool_call_id: call.id, content: 'unsupported tool call' };
        }
        if (call.function.name === 'finalizeAssignment') {
          // Already handled above (invalid assignee path) — skip re-running.
          return null;
        }
        const content = await runReadTool(
          repoId,
          taskId,
          call.function.name,
          safeParse(call.function.arguments),
        );
        return { tool_call_id: call.id, content };
      }),
    );

    for (const r of results) {
      if (!r) continue;
      messages.push({
        role: 'tool',
        tool_call_id: r.tool_call_id,
        content: r.content,
      });
    }
  }

  // ---- Fallback: ran out of rounds without finalize -----------------------
  // Pick the least-loaded member and assign via the same write path.
  const fallback = members.reduce((best, m) =>
    m.activeIssueCount < best.activeIssueCount ? m : best,
  );
  logger.warn('assignTaskFlow: round limit hit, fallback to least-loaded', {
    repoId,
    taskId,
    assigneeId: fallback.userId,
  });
  await applyAssignment(repoId, taskId, fallback.userId);
  return {
    assigneeId: fallback.userId,
    reasoning:
      'AI 未在限定回合內決定，依負載最低（activeIssueCount 最小）自動分派。',
  };
}

// ---- Helpers ---------------------------------------------------------------

/** Execute a non-finalize read tool, returning a JSON string for the model. */
async function runReadTool(
  repoId: string,
  taskId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'readTeamState':
      return JSON.stringify(await readTeamState(repoId));
    case 'searchMemberCommits':
      return JSON.stringify(
        await searchMemberCommits(
          repoId,
          String(args.memberId ?? ''),
          String(args.query ?? ''),
        ),
      );
    case 'getTaskDependents':
      return JSON.stringify(await getTaskDependents(repoId, taskId));
    default:
      return `Error: unknown tool ${name}`;
  }
}

/** Initial user message: the task to assign + a primed team snapshot. */
function buildTaskBrief(
  repoId: string,
  taskId: string,
  task: Record<string, unknown>,
  members: Awaited<ReturnType<typeof readTeamState>>,
): string {
  return [
    `repoId: ${repoId}`,
    `taskId: ${taskId}`,
    `Task title: ${task.title ?? '(untitled)'}`,
    task.description ? `Task description: ${task.description}` : undefined,
    `Current assignee: ${task.assigneeId ?? 'none'}`,
    '',
    'Team snapshot (you may also call readTeamState for the live view):',
    JSON.stringify(members),
    '',
    'Decide the best assignee and call finalizeAssignment.',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
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
