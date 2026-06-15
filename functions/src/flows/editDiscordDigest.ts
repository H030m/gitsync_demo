// editDiscordDigestFlow — AI-rewrites an existing Discord daily digest in place
// per a natural-language instruction. Shared by the app callable
// (`editDiscordDigest`) and the bot command bridge (`botEditDigest`).
//
// AGENTIC: an OpenAI function-calling loop the model drives itself — it may pull
// the day's raw messages (searchDiscordMessages, scoped to that day) or read a
// neighboring day's digest (getDaySummary) before rewriting, then terminates in
// writeDigest(markdown). A best-effort agent trace (`runId`, app callable only)
// streams the loop's progress; the bot bridge omits it (no client → no-op).
//
// Lock semantics (ARCHITECTURE §7): a digest with `locked === true` is frozen —
// this flow refuses to edit it, and `discordDailyDigestFlow` refuses to
// regenerate it. The lock is the single gate every digest-write path checks.
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import type OpenAI from 'openai';

import { db } from '../admin';
import { getOpenAI, MODELS } from '../config';
import { taipeiDayBounds } from './discordDailyDigest';
import {
  searchDiscordMessages,
  getDaySummary,
  type SearchRange,
} from '../tools/discordSearch';
import {
  startRun,
  appendStep,
  finishRun,
  TRACE_LABELS,
} from '../tools/agentTrace';
import {
  editDiscordDigestSystem,
  editDiscordDigestSeed,
} from '../prompts/editDiscordDigest';

// Taipei is a fixed UTC+8 offset year-round (matches discordDailyDigestFlow).
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

// ---- Agentic loop caps (mirrors explainCommit) -----------------------------
const ROUNDS_CAP = 4;
const MAX_TOOL_CALLS = 6;
const HARD_ROUND_CEILING = ROUNDS_CAP + 3;
/** How many discord snippets a search result is flattened/trimmed to. */
const MAX_DISCORD_MESSAGES = 16;

export interface EditDiscordDigestInput {
  repoId: string;
  date: string; // YYYY-MM-DD
  instruction: string;
  /** Client-generated agent-trace doc id (app callable only); absent → no-op. */
  runId?: string;
}

export interface EditDiscordDigestResult {
  date: string;
  markdown: string;
}

// OpenAI tool schema for the rewrite loop. `writeDigest` ends it.
const EDIT_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'searchDiscordMessages',
      description:
        "Semantic search this day's RAW Discord messages for exact quotes, " +
        'names, or details the current summary omits. Returns grouped snippets.',
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
      name: 'getDaySummary',
      description:
        'Read a neighboring day\'s AI digest (YYYY-MM-DD) for cross-day context.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Day to fetch, YYYY-MM-DD.' },
        },
        required: ['date'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'writeDigest',
      description:
        'Submit the full revised digest as Markdown. Ends the loop.',
      parameters: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: 'The full revised digest.' },
        },
        required: ['markdown'],
        additionalProperties: false,
      },
    },
  },
];

/** Today's date string (YYYY-MM-DD) in the Asia/Taipei timezone. */
export function taipeiTodayString(now: Date): string {
  const taipei = new Date(now.getTime() + TAIPEI_OFFSET_MS);
  return taipei.toISOString().slice(0, 10);
}

/**
 * Revise the digest at `discordDigests/{date}` per `instruction`. Throws an
 * HttpsError on a missing day (`not-found`) or a locked digest
 * (`failed-precondition`) — both callers translate that to a user-facing
 * message.
 */
export async function editDiscordDigestFlow(
  input: EditDiscordDigestInput,
): Promise<EditDiscordDigestResult> {
  const { repoId, date, instruction, runId } = input;
  const ref = db.doc(`apps/gitsync/repos/${repoId}/discordDigests/${date}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `No digest for ${date} yet.`);
  }
  const data = snap.data() ?? {};
  if (data.locked === true) {
    throw new HttpsError('failed-precondition', 'This digest is locked.');
  }

  const current = (data.markdown as string | undefined) ?? '';
  logger.info('editDiscordDigestFlow: rewriting digest', { repoId, date });

  // searchDiscordMessages is scoped to this digest's own day so the agent pulls
  // the messages the summary was built from (best-effort: a malformed date can't
  // happen here — the date already keyed an existing digest doc).
  let dayRange: SearchRange | undefined;
  try {
    const { start, end } = taipeiDayBounds(date);
    dayRange = { start, end, startDate: date, endDate: date };
  } catch {
    dayRange = undefined;
  }

  // Best-effort agent trace (no-op without a runId — e.g. the bot bridge).
  await startRun(repoId, runId, 'editDiscordDigest');

  const openai = getOpenAI();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: editDiscordDigestSystem },
    { role: 'user', content: editDiscordDigestSeed({ date, current, instruction }) },
  ];

  try {
    let markdown: string | null = null;
    let rounds = 0;
    let toolCalls = 0;

    while (markdown === null) {
      if (rounds >= HARD_ROUND_CEILING) {
        throw new HttpsError('internal', 'editDiscordDigest did not converge');
      }
      const forceWrite = rounds >= ROUNDS_CAP - 1 || toolCalls >= MAX_TOOL_CALLS;

      const completion = await openai.chat.completions.create({
        model: MODELS.fast,
        messages,
        tools: EDIT_TOOLS,
        tool_choice: forceWrite
          ? { type: 'function', function: { name: 'writeDigest' } }
          : 'auto',
      });
      rounds++;

      const choice = completion.choices[0]?.message;
      if (!choice) {
        throw new HttpsError('internal', 'OpenAI returned no message');
      }
      messages.push(choice);

      const calls = choice.tool_calls ?? [];
      if (calls.length === 0) {
        // Model returned the revised digest as prose instead of calling
        // writeDigest — accept it. Only nudge on an empty turn.
        const answer = (choice.content ?? '').trim();
        if (answer) {
          markdown = answer;
          break;
        }
        messages.push({
          role: 'user',
          content:
            'Call writeDigest with the full revised summary, or a tool to gather evidence.',
        });
        continue;
      }

      // writeDigest wins if present this turn (finalize precedence).
      const writeCall = calls.find(
        (c) => c.type === 'function' && c.function.name === 'writeDigest',
      );
      if (writeCall && writeCall.type === 'function') {
        const args = safeParse(writeCall.function.arguments);
        markdown = String(args.markdown ?? '').trim();
        for (const c of calls) {
          messages.push({
            role: 'tool',
            tool_call_id: c.id,
            content: c.id === writeCall.id ? 'ok' : 'superseded by writeDigest',
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
          const content = await runEditTool(
            repoId,
            dayRange,
            call.function.name,
            safeParse(call.function.arguments),
          );
          return { id: call.id, content };
        }),
      );
      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }

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

    // An empty model write keeps the existing digest (never blank it out).
    const finalMarkdown = markdown || current;

    await ref.set(
      {
        markdown: finalMarkdown,
        editedAt: FieldValue.serverTimestamp(),
        lastEditInstruction: instruction,
      },
      { merge: true },
    );

    await finishRun(repoId, runId, 'done');
    return { date, markdown: finalMarkdown };
  } catch (err) {
    await finishRun(repoId, runId, 'error');
    throw err;
  }
}

// ---- Helpers ---------------------------------------------------------------

/** Execute a non-terminal read tool, returning a JSON string for the model. */
async function runEditTool(
  repoId: string,
  dayRange: SearchRange | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'searchDiscordMessages': {
      const snippets = await searchDiscordMessages(
        repoId,
        String(args.query ?? ''),
        undefined,
        dayRange,
      );
      const flat = snippets
        .flatMap((s) => s.messages)
        .map((m) => ({ author: m.authorName, content: m.content }))
        .slice(0, MAX_DISCORD_MESSAGES);
      return JSON.stringify(flat);
    }
    case 'getDaySummary': {
      const day = await getDaySummary(repoId, String(args.date ?? ''));
      return JSON.stringify(day ?? { error: 'no digest for that day' });
    }
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

/**
 * Resolve which repo a Discord channel is bound to. Returns the first repo
 * whose `discordChannelIds` array contains `channelId`, or null. Used by the
 * bot bridge, which only knows the channel it was invoked in.
 */
export async function repoIdForChannel(channelId: string): Promise<string | null> {
  const snap = await db
    .collection('apps/gitsync/repos')
    .where('discordChannelIds', 'array-contains', channelId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}
