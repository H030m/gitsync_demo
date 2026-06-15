// summarizeDayFlow — produces an agentic report for one repo over an inclusive
// Asia/Taipei day range (a single day when startDate == endDate) from commits +
// completed tasks + Discord discussion. See ARCHITECTURE.md §5.4. Invoked by
// Cloud Tasks (fan-out from `scheduledDailyReport`, always single-day) and by
// the `summarizeDay` callable (the Summary tab's Regenerate button, which may
// pass a user-picked range).
//
// AGENTIC: an OpenAI function-calling loop. The range's commits / tasks /
// roster are pre-fetched deterministically (so the per-member counts are exact
// — counting is never delegated to the LLM, AGENTIC_CONCEPTS §4 "pruning");
// the agent then freely drills deeper via tools (`listRangeDigests`,
// `listRangeDiscordMessages`, `searchPastCommits`) before calling
// `finalizeReport` with the narrative (summary / highlights / blockers /
// commit themes). Mirrors the `discordChatFlow` / `assignTaskFlow` loop.
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';
import type OpenAI from 'openai';

import { db } from '../admin';
import { getOpenAI, MODELS } from '../config';
import { summarizeDaySystemPrompt, summarizeDayContext } from '../prompts/summarizeDay';
import {
  listRangeCommits,
  listRangeCompletedTasks,
  listRangeDigests,
  listRangeDiscordMessages,
  searchPastCommits,
  computeContributions,
  readRoster,
  type MemberContributions,
} from '../tools/dailyIntel';
import { mergeProjectBrief, renderReportForBrief } from '../tools/projectBrief';
import type { CommitTheme, DailyReportNarrative } from '../types';

export interface SummarizeDayInput {
  repoId: string;
  startDate: string; // YYYY-MM-DD, inclusive
  endDate: string; // YYYY-MM-DD, inclusive (== startDate for a single day)
  /**
   * W6: optional human-readable English language NAME (e.g. "Traditional
   * Chinese") that forces the narrative (summary / highlights / blockers /
   * commit themes) into the user's app language on an explicit regenerate. The
   * deterministic counts/contributions stay language-neutral. Absent/empty →
   * unchanged behavior (the scheduled report never sends it).
   */
  language?: string;
}

export interface SummarizeDayResult {
  summary: string;
  highlights: string[];
  blockers: string[];
  commitThemes: CommitTheme[];
  memberContributions: MemberContributions;
  completedTaskIds: string[];
  commitCount: number;
  startDate: string;
  endDate: string;
}

/** Report doc id: the date for a single day, `{start}_{end}` for a range. */
export function reportDocId(startDate: string, endDate: string): string {
  return startDate === endDate ? startDate : `${startDate}_${endDate}`;
}

const MAX_ROUNDS = 4;

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'listRangeDigests',
      description:
        "Read the per-day AI digests of the period's Discord discussion, to " +
        'mine for blockers, decisions, and context the commits alone do not ' +
        'show. CHEAP — start here for "what was discussed". Returns [] when ' +
        'no day in the period has a digest.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listRangeDiscordMessages',
      description:
        "Read the period's RAW Discord messages (capped). Use ONLY when " +
        'listRangeDigests returned nothing for days that matter — raw messages ' +
        'are much more expensive to read than digests.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max messages (default 200).' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchPastCommits',
      description:
        'Keyword search the repo history (across all time) to ground a theme — ' +
        'e.g. find when a feature was last touched. Use sparingly; the period ' +
        'context is already provided.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms.' },
          limit: { type: 'number', description: 'Max commits (default 6).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finalizeReport',
      description:
        'Submit the finished report. Call this exactly once, after you have ' +
        'read the context, to end the task.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description:
              '2-3 plain-English sentences for a non-technical reader.',
          },
          highlights: {
            type: 'array',
            items: { type: 'string' },
            description: "The period's key achievements, most important first.",
          },
          blockers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Blockers/risks; empty array if none.',
          },
          commitThemes: {
            type: 'array',
            description: "The period's commits grouped into themes.",
            items: {
              type: 'object',
              properties: {
                theme: { type: 'string' },
                summary: { type: 'string' },
                commitCount: { type: 'number' },
              },
              required: ['theme', 'summary', 'commitCount'],
              additionalProperties: false,
            },
          },
        },
        required: ['summary', 'highlights', 'blockers', 'commitThemes'],
        additionalProperties: false,
      },
    },
  },
];

export async function summarizeDayFlow(
  input: SummarizeDayInput,
): Promise<SummarizeDayResult> {
  const { repoId, startDate, endDate, language } = input;
  logger.info('summarizeDayFlow: start', { repoId, startDate, endDate });

  // ---- Step 1: deterministic context (exact counts, not LLM-guessed) -------
  const [commits, tasks, roster] = await Promise.all([
    listRangeCommits(repoId, startDate, endDate),
    listRangeCompletedTasks(repoId, startDate, endDate),
    readRoster(repoId),
  ]);
  const memberContributions = computeContributions(commits, tasks, roster);
  const completedTaskIds = tasks.map((t) => t.id);

  // ---- Step 2: agentic narrative loop --------------------------------------
  const narrative = await runReportAgent(
    repoId,
    startDate,
    endDate,
    commits,
    tasks,
    language,
  );

  // commitThemes counts come from the model's grouping; clamp to >= 0.
  const commitThemes = narrative.commitThemes.map((t) => ({
    ...t,
    commitCount: Math.max(0, Math.round(t.commitCount)),
  }));

  const result: SummarizeDayResult = {
    summary: narrative.summary,
    highlights: narrative.highlights,
    blockers: narrative.blockers,
    commitThemes,
    memberContributions,
    completedTaskIds,
    commitCount: commits.length,
    startDate,
    endDate,
  };

  // ---- Step 3: persist (Cloud Functions are the only writer; clients RO) ----
  const docId = reportDocId(startDate, endDate);
  await db.doc(`apps/gitsync/repos/${repoId}/dailyReports/${docId}`).set({
    date: docId,
    startDate,
    endDate,
    repoId,
    summary: result.summary,
    highlights: result.highlights,
    blockers: result.blockers,
    commitThemes: result.commitThemes,
    memberContributions: result.memberContributions,
    completedTasks: result.completedTaskIds,
    commitCount: result.commitCount,
    generatedAt: FieldValue.serverTimestamp(),
  });

  logger.info('summarizeDayFlow: wrote report', {
    repoId,
    docId,
    commits: commits.length,
    tasks: tasks.length,
  });

  // ---- Step 4: roll the project brief (best-effort; never fails the report) ----
  try {
    await mergeProjectBrief(repoId, renderReportForBrief(result));
  } catch (err) {
    logger.warn('summarizeDayFlow: projectBrief merge failed (best-effort)', {
      repoId,
      docId,
      err: String(err),
    });
  }

  return result;
}

/** The OpenAI function-calling loop that authors the report narrative. */
async function runReportAgent(
  repoId: string,
  startDate: string,
  endDate: string,
  commits: Awaited<ReturnType<typeof listRangeCommits>>,
  tasks: Awaited<ReturnType<typeof listRangeCompletedTasks>>,
  language?: string,
): Promise<DailyReportNarrative> {
  const openai = getOpenAI();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: summarizeDaySystemPrompt(language) },
    {
      role: 'user',
      content: summarizeDayContext({ startDate, endDate, commits, tasks }),
    },
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const forceFinalize = round === MAX_ROUNDS - 1;
    const completion = await openai.chat.completions.create({
      model: MODELS.fast,
      messages,
      tools: TOOLS,
      // On the last round, force the agent to finalize so we always get output.
      tool_choice: forceFinalize
        ? { type: 'function', function: { name: 'finalizeReport' } }
        : 'auto',
    });

    const choice = completion.choices[0]?.message;
    if (!choice) break;
    messages.push(choice);

    const toolCalls = choice.tool_calls ?? [];
    if (toolCalls.length === 0) continue; // model mused without a tool; loop.

    let finalized: DailyReportNarrative | null = null;
    const results = await Promise.all(
      toolCalls.map(async (call) => {
        if (call.type !== 'function') {
          return { id: call.id, content: 'unsupported tool call' };
        }
        const args = safeParse(call.function.arguments);
        switch (call.function.name) {
          case 'listRangeDigests': {
            const digests = await listRangeDigests(repoId, startDate, endDate);
            return { id: call.id, content: JSON.stringify(digests) };
          }
          case 'listRangeDiscordMessages': {
            const msgs = await listRangeDiscordMessages(
              repoId,
              startDate,
              endDate,
              typeof args.limit === 'number' ? args.limit : 200,
            );
            return { id: call.id, content: JSON.stringify(msgs) };
          }
          case 'searchPastCommits': {
            const hits = await searchPastCommits(
              repoId,
              String(args.query ?? ''),
              typeof args.limit === 'number' ? args.limit : 6,
            );
            return { id: call.id, content: JSON.stringify(hits) };
          }
          case 'finalizeReport': {
            finalized = normalizeNarrative(args);
            return { id: call.id, content: 'ok' };
          }
          default:
            return { id: call.id, content: `unknown tool ${call.function.name}` };
        }
      }),
    );

    for (const r of results) {
      messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
    if (finalized) return finalized;
  }

  // Loop exhausted without a finalize (should not happen — last round forces
  // it). Degrade to a deterministic summary so the report is never empty.
  logger.warn('summarizeDayFlow: agent did not finalize; using fallback', {
    repoId,
    startDate,
    endDate,
  });
  return fallbackNarrative(commits, tasks);
}

/** Coerce finalize-tool args into a well-formed narrative. */
function normalizeNarrative(args: Record<string, unknown>): DailyReportNarrative {
  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  const themes = Array.isArray(args.commitThemes) ? args.commitThemes : [];
  return {
    summary: String(args.summary ?? '').trim(),
    highlights: asStrings(args.highlights),
    blockers: asStrings(args.blockers),
    commitThemes: themes.map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      return {
        theme: String(o.theme ?? '').trim(),
        summary: String(o.summary ?? '').trim(),
        commitCount: Number(o.commitCount ?? 0) || 0,
      };
    }),
  };
}

/** Deterministic narrative used only if the agent never finalizes. */
function fallbackNarrative(
  commits: Awaited<ReturnType<typeof listRangeCommits>>,
  tasks: Awaited<ReturnType<typeof listRangeCompletedTasks>>,
): DailyReportNarrative {
  const summary =
    commits.length === 0 && tasks.length === 0
      ? 'No commits or completed tasks were recorded for this period.'
      : `${commits.length} commit(s) landed and ${tasks.length} task(s) were ` +
        'completed.';
  return {
    summary,
    highlights: tasks.map((t) => `Completed: ${t.title}`),
    blockers: [],
    commitThemes: commits.length
      ? [
          {
            theme: 'Commits',
            summary: `${commits.length} commit(s) across the repo.`,
            commitCount: commits.length,
          },
        ]
      : [],
  };
}

function safeParse(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
