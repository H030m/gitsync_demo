// discordChatFlow — agentic OpenAI function-calling loop that answers a user's
// question about the team's Discord chat. The model calls `searchDiscordMessages`
// to retrieve relevant messages, then composes an answer. Every message the
// tool surfaces across the loop is collected (deduped by messageId) and returned
// alongside the answer so the client can render them in a scrollable panel.
// See ARCHITECTURE.md §7 and prd.md (06-03-discord-ai-chat).
//
// Mirrors the assignTaskFlow pattern: `chat.completions.create` with `tools` +
// `tool_choice: 'auto'`, looped until the model answers without a tool call.
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import type OpenAI from 'openai';

import { getOpenAI, MODELS } from '../config';
import { discordChatSystem } from '../prompts/discordChat';
import { taipeiRangeBounds } from '../tools/dailyIntel';
import {
  searchDiscordMessages,
  listDaySummaries,
  getDaySummary,
  type DiscordSnippet,
  type SearchRange,
} from '../tools/discordSearch';
import {
  startRun,
  appendStep,
  finishRun,
  TRACE_LABELS,
} from '../tools/agentTrace';

/** One prior conversation turn passed in from the client. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface DiscordChatInput {
  repoId: string;
  question: string;
  history?: ChatTurn[];
  /** Optional active window (both-or-neither, YYYY-MM-DD); scopes AI reads. */
  startDate?: string;
  endDate?: string;
  /** Client-generated agent-trace doc id; absent → the trace is a no-op. */
  runId?: string;
}

export interface DiscordChatResult {
  answer: string;
  snippets: DiscordSnippet[];
}

/** Stable key for deduping a snippet across multiple tool calls in one turn. */
function snippetKey(s: DiscordSnippet): string {
  const first = s.messages[0]?.messageId ?? '';
  const last = s.messages[s.messages.length - 1]?.messageId ?? '';
  return `${s.channelId}:${first}:${last}`;
}

const MAX_ROUNDS = 4;
// How many previous turns to replay for context (keeps the prompt bounded).
const MAX_HISTORY_TURNS = 8;

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'listDaySummaries',
      description:
        'List the available per-day AI digests of the chat (newest first), ' +
        'each a tiny preview with its date and message count. CHEAP — start ' +
        'here for summary / overview / "what happened" questions to locate the ' +
        'relevant days WITHOUT reading every raw message.',
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
      name: 'getDaySummary',
      description:
        "Get the full AI digest (markdown) for one day (YYYY-MM-DD). Use after " +
        'listDaySummaries to read a relevant day in depth. Much cheaper than ' +
        'reading that day\'s raw messages.',
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
      name: 'searchDiscordMessages',
      description:
        "Keyword search over the team's RAW ingested Discord messages. Returns " +
        'grouped conversation SNIPPETS: each match comes bundled with a few ' +
        'surrounding messages for context (isMatch marks the matched ones), and ' +
        'distinct conversations are separate snippets. Use this when you need ' +
        'specific quotes / exact wording / who-said-what / the back-and-forth ' +
        'around a topic — for broad summaries prefer the day-summary tools above.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Natural-language search terms drawn from the question. Pass an ' +
              'empty string when you only want a person\'s messages (use author).',
          },
          author: {
            type: 'string',
            description:
              "Restrict to ONE person's messages. Matched fuzzily against the " +
              "Discord display name (e.g. \"鯨魚島麻糬\") OR the @handle (e.g. " +
              '"whale_island") — pass whatever name the user used. Use this for ' +
              '"what did X say", "list X\'s messages", or "X 說了什麼".',
          },
          limit: {
            type: 'number',
            description: 'Max messages to return (default 12, max 30).',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
];

export async function discordChatFlow(
  input: DiscordChatInput,
): Promise<DiscordChatResult> {
  const { repoId, question } = input;
  const history = Array.isArray(input.history) ? input.history : [];

  // Time-scope: every read tool is restricted to the active window. When the
  // client passes one, use it; when it DOESN'T (older app builds that left the
  // chat unscoped), default to TODAY (Asia/Taipei) so the chat matches the
  // displayed "today" window instead of pulling unrelated past days.
  let range: SearchRange | undefined;
  const startDate = input.startDate || taipeiTodayKey();
  const endDate = input.endDate || taipeiTodayKey();
  try {
    const { start, end } = taipeiRangeBounds(startDate, endDate);
    range = { start, end, startDate, endDate };
  } catch (err) {
    logger.warn('discordChatFlow: bad range, ignoring (unscoped)', {
      repoId,
      startDate,
      endDate,
      err: String(err),
    });
  }

  const systemPrompt = range
    ? `${discordChatSystem}\n\nScope: only messages and digests between ${range.startDate} and ${range.endDate} (inclusive, Asia/Taipei) are available. Do NOT ask for or reference days outside this window.`
    : discordChatSystem;

  const openai = getOpenAI();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...history
      .slice(-MAX_HISTORY_TURNS)
      .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && t.content)
      .map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: question },
  ];

  // Surfaced snippets accumulate across rounds; dedupe by snippet key, preserve
  // first-seen order (the order the agent found them in).
  const surfaced = new Map<string, DiscordSnippet>();

  // Best-effort agent trace (no-op without a runId). Trace writes NEVER affect
  // this flow's control flow or result; on any throw we still mark it errored.
  await startRun(repoId, input.runId, 'discordChat');
  try {
    let answer: string | null = null;

    for (let round = 0; round < MAX_ROUNDS && answer === null; round++) {
      logger.info('discordChatFlow: round', { repoId, round });

      const completion = await openai.chat.completions.create({
        model: MODELS.fast,
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
        // Model answered — we're done.
        answer = choice.content ?? '';
        break;
      }

      // Execute the (search) tool calls and feed results back for the next round.
      const results = await Promise.all(
        toolCalls.map(async (call) => {
          if (call.type !== 'function') {
            return { tool_call_id: call.id, content: 'unsupported tool call' };
          }
          const args = safeParse(call.function.arguments);
          switch (call.function.name) {
            case 'listDaySummaries': {
              const days = await listDaySummaries(repoId, range);
              return { tool_call_id: call.id, content: JSON.stringify(days) };
            }
            case 'getDaySummary': {
              const date = String(args.date ?? '');
              // Honor the active window — refuse out-of-scope day reads.
              if (range && (date < range.startDate || date > range.endDate)) {
                return {
                  tool_call_id: call.id,
                  content: JSON.stringify({
                    error: `out of scope: ${date} is outside ${range.startDate}..${range.endDate}`,
                  }),
                };
              }
              const day = await getDaySummary(repoId, date);
              return {
                tool_call_id: call.id,
                content: JSON.stringify(day ?? { error: 'no digest for that day' }),
              };
            }
            case 'searchDiscordMessages': {
              const found = await searchDiscordMessages(
                repoId,
                String(args.query ?? ''),
                typeof args.limit === 'number' ? args.limit : undefined,
                range,
                typeof args.author === 'string' ? args.author : undefined,
              );
              for (const s of found) surfaced.set(snippetKey(s), s);
              return { tool_call_id: call.id, content: JSON.stringify(found) };
            }
            default:
              return {
                tool_call_id: call.id,
                content: `Error: unknown tool ${call.function.name}`,
              };
          }
        }),
      );

      for (const r of results) {
        messages.push({
          role: 'tool',
          tool_call_id: r.tool_call_id,
          content: r.content,
        });
      }

      // One batch trace write per tool round (best-effort, no-op without runId).
      await appendStep(
        repoId,
        input.runId,
        toolCalls.map((c) =>
          c.type === 'function'
            ? (TRACE_LABELS as Record<string, string>)[c.function.name] ?? c.function.name
            : '',
        ),
      );
    }

    // Ran out of rounds without a plain-text answer — ask once more, no tools.
    if (answer === null) {
      logger.warn('discordChatFlow: round limit hit, forcing a final answer', {
        repoId,
      });
      await appendStep(repoId, input.runId, TRACE_LABELS.composing);
      const finalCompletion = await openai.chat.completions.create({
        model: MODELS.fast,
        messages: [
          ...messages,
          {
            role: 'user',
            content:
              'Now answer my question using what you found above. Do not call any more tools.',
          },
        ],
      });
      answer = finalCompletion.choices[0]?.message?.content ?? '';
    }

    await finishRun(repoId, input.runId, 'done');
    return { answer, snippets: [...surfaced.values()] };
  } catch (err) {
    await finishRun(repoId, input.runId, 'error');
    throw err;
  }
}

/** Today's date (YYYY-MM-DD) in Asia/Taipei (UTC+8), without a tz library. */
function taipeiTodayKey(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
