// askRepoFlow — GitSync's UNIFIED, repo-wide "ask anything" agent. One agentic
// OpenAI function-calling loop over the full read-only tool set (recent commits
// / completed tasks / Discord digests / past-commit + Discord semantic search /
// repo planning docs / task dependents / team roster) so a developer can ask a
// single input box about progress, people, code, and discussion — replacing the
// per-tab chats. See prd.md (06-12-w5-ask-repo).
//
// Skeleton cloned/extended from flows/dailyBriefChat.ts: MODELS.fast, a bounded
// round loop that runs every round's tool_calls in parallel and feeds the
// JSON-stringified results back, terminating when the model answers with no tool
// call (or a forced no-tools final answer at the round cap). Commits (deduped by
// sha) and Discord snippets (deduped by snippetKey) surfaced across the loop are
// returned alongside the answer as cited sources.
//
// Backend B — agent tool-trace: each round's executed tools are recorded to a
// best-effort Firestore side-channel (tools/agentTrace.ts) keyed by the
// client-generated runId, so the UI can stream the progress while waiting. Trace
// writes NEVER affect the flow (every helper swallows its own errors).
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import type OpenAI from 'openai';

import { zodResponseFormat } from 'openai/helpers/zod';

import { getOpenAI, MODELS } from '../config';
import { askRepoSystem } from '../prompts/askRepo';
import { askRepoPlannerSystem, formatPlanForPrompt } from '../prompts/askRepoPlanner';
import { AskRepoPlanSchema, type AskRepoPlan } from '../types';
import { readProjectBrief, formatBriefForPrompt } from '../tools/projectBrief';
import {
  listRangeCommits,
  listRangeCompletedTasks,
  listRangeDigests,
  searchPastCommits,
  type DayCommit,
} from '../tools/dailyIntel';
import {
  searchDiscordMessages,
  type DiscordSnippet,
} from '../tools/discordSearch';
import { readRepoPlanningDocs } from '../tools/repoDocs';
import { getTaskDependents, readTeamState } from '../tools/assignTools';
import { getCommitDiff } from '../tools/handoffTools';
import {
  startRun,
  appendStep,
  finishRun,
  TRACE_LABELS,
} from '../tools/agentTrace';

/** One prior conversation turn from the client. */
export interface AskRepoTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskRepoInput {
  repoId: string;
  question: string;
  history?: AskRepoTurn[];
  /** Client-generated id for the agent-trace doc. Absent → trace is a no-op. */
  runId?: string;
}

/** One labeled commit "window" the agent surfaced — the result of a single
 *  listDayCommits / searchPastCommits call. `label` is the person / task /
 *  search the window represents (empty = a plain recent-activity window, which
 *  the UI renders under a localized default header). */
export interface CommitGroup {
  label: string;
  commits: DayCommit[];
}

export interface AskRepoResult {
  answer: string;
  // Flat, deduped-by-sha union of every window (kept for backward compat with
  // the fake backend / existing clients that read `commits`).
  commits: DayCommit[];
  // The same commits split into the agent's per-person / per-task windows, in
  // the order the agent surfaced them. The UI renders one panel per group.
  commitGroups: CommitGroup[];
  snippets: DiscordSnippet[]; // Discord clusters surfaced (deduped by key)
}

const MAX_ROUNDS = 5;
const MAX_HISTORY_TURNS = 8;
/** Default look-back window (days) for the day-scoped tools (prd Q1). */
const DEFAULT_DAYS = 30;
/** Hard cap on the look-back window the model can request (prd Q1). */
const MAX_DAYS = 92;

/** Stable key for deduping a Discord snippet across tool calls (same rule as
 *  discordChat.ts: channelId : firstMessageId : lastMessageId). */
function snippetKey(s: DiscordSnippet): string {
  const first = s.messages[0]?.messageId ?? '';
  const last = s.messages[s.messages.length - 1]?.messageId ?? '';
  return `${s.channelId}:${first}:${last}`;
}

// The day-scoped tools accept an optional `days` window (prd Q1: default 30,
// hard cap 92); all-time lookups go through searchPastCommits / the Discord
// semantic search instead.
const DAYS_PARAM = {
  days: {
    type: 'number',
    description: `Look-back window in days (default ${DEFAULT_DAYS}, max ${MAX_DAYS}).`,
  },
} as const;

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'listDayCommits',
      description:
        'List commits committed in the last `days` days (author, message, ' +
        'one-line AI summary, linked tasks, commit time). Start here for "what ' +
        'landed". Pass `authorLogin` to get ONE person\'s commits, or `taskId` ' +
        'to get a single task\'s commits — call it once per person / task to ' +
        'build separate, labeled windows for a project-wide question.',
      parameters: {
        type: 'object',
        properties: {
          ...DAYS_PARAM,
          authorLogin: {
            type: 'string',
            description:
              "Only this author's commits. Matched fuzzily: pass a GitHub login " +
              'OR a partial / informal name (e.g. "opal" matches the login ' +
              '"opaL1022", and a display name also matches), so you do not need ' +
              'the exact login. The window is labeled with this person.',
          },
          taskId: {
            type: 'string',
            description:
              'Only commits linked to this task id. The window is labeled with the task.',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listCompletedTasks',
      description: 'List tasks that reached done in the last `days` days.',
      parameters: { type: 'object', properties: { ...DAYS_PARAM }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listRangeDigests',
      description:
        'Read the per-day AI digests of the last `days` days of Discord ' +
        'discussion (decisions, blockers). Returns [] when no day has a digest.',
      parameters: { type: 'object', properties: { ...DAYS_PARAM }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchPastCommits',
      description:
        'Semantic search of the WHOLE commit history (all time) — for "when ' +
        'did we last…" / "who wrote…" / cross-period questions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms.' },
          limit: { type: 'number', description: 'Max commits (default 8).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchDiscordMessages',
      description:
        "Semantic search of the team's Discord messages. Returns grouped " +
        'conversation snippets (matched messages + surrounding context) — for ' +
        'exact wording / who-said-what / the back-and-forth around a topic.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language search terms.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getCommitDiff',
      description:
        'Fetch the ACTUAL unified diff (per-file patches + add/del line stats) ' +
        'of ONE commit by its sha, so you can explain what TRULY changed instead ' +
        'of paraphrasing its one-line summary. Use it when the user asks "what ' +
        'did this commit/PR change", "what did X actually do", or to verify a ' +
        'concrete claim. NOTE: a MERGE commit usually has an empty diff — do NOT ' +
        'call this on a merge; instead summarize the individual commits the merge ' +
        'brought in (from listDayCommits / searchPastCommits). Call sparingly ' +
        '(1–3 well-chosen shas). GitHub-backed, best-effort (null when ' +
        'unavailable — e.g. no repo token / private repo).',
      parameters: {
        type: 'object',
        properties: {
          sha: {
            type: 'string',
            description: 'Full or short commit sha from a commit window.',
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
      name: 'readRepoPlanningDocs',
      description:
        "Read the repo's in-repo planning context (.trellis tasks/prd, " +
        'AGENTS.md/CLAUDE.md, docs) — project conventions and what is already ' +
        'done. Cheap (cached).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getTaskDependents',
      description:
        'List the tasks blocked by a given task (who is waiting on it).',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task id to check.' },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'readTeamState',
      description:
        'List repo members (name + GitHub login) so you can refer to people ' +
        'by real name.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];

/** YYYY-MM-DD for `date` in Asia/Taipei (UTC+8), without a tz lib. */
function taipeiDateKey(date: Date): string {
  const taipei = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return taipei.toISOString().slice(0, 10);
}

/** Clamp the model-requested `days` into [1, MAX_DAYS], defaulting to 30. */
function clampDays(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_DAYS;
  return Math.max(1, Math.min(n, MAX_DAYS));
}

export async function askRepoFlow(input: AskRepoInput): Promise<AskRepoResult> {
  const { repoId, question, runId } = input;
  const history = Array.isArray(input.history) ? input.history : [];

  const today = taipeiDateKey(new Date());
  const sinceKey = (days: number): string =>
    taipeiDateKey(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000));

  // Best-effort project-brief prefix (stable, cache-friendly; empty → '').
  const briefPrefix = formatBriefForPrompt(await readProjectBrief(repoId));

  const openai = getOpenAI();

  // ---- Planner pre-step: interpret intent BEFORE searching -----------------
  // Restate the (often informal) question as a structured search intent so the
  // agent searches with the right fuzzy params (resolved people, time window,
  // semantic topics) instead of the literal wording. Best-effort: a failure
  // leaves `planGuidance` empty and the flow runs exactly as before.
  const planGuidance = await planQuery(openai, today, question, history);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: askRepoSystem(today, DEFAULT_DAYS, briefPrefix + planGuidance),
    },
    ...history
      .slice(-MAX_HISTORY_TURNS)
      .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && t.content)
      .map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: question },
  ];

  // Sources surfaced across rounds — commits split into labeled "windows" (one
  // per listDayCommits / searchPastCommits call), snippets deduped by key, both
  // in first-seen order (the order the agent found them).
  //
  // Each window is the result of one tool call: a per-person / per-task
  // listDayCommits, or a semantic search. Caps keep a broad "how's progress"
  // question bounded WITHOUT surfacing the whole history; the prompt tells the
  // agent to summarize in prose, group by person/task, and NEVER mention these
  // limits to the user. A commit already shown in an earlier window is not
  // repeated in a later one (deduped across windows by sha).
  const PER_GROUP_COMMITS = 10; // cap per window
  const MAX_SURFACED_COMMITS = 50; // global safety cap across all windows
  const seenShas = new Set<string>();
  const groups = new Map<string, DayCommit[]>(); // label → window (insertion order)
  const collectCommits = (cs: DayCommit[], label: string) => {
    const bucket = groups.get(label) ?? [];
    if (!groups.has(label)) groups.set(label, bucket);
    for (const c of cs) {
      if (seenShas.size >= MAX_SURFACED_COMMITS) break;
      if (bucket.length >= PER_GROUP_COMMITS) break;
      if (seenShas.has(c.sha)) continue;
      seenShas.add(c.sha);
      bucket.push(c);
    }
  };
  const buildResult = (answer: string): AskRepoResult => {
    const commitGroups = [...groups.entries()]
      .map(([label, commits]) => ({ label, commits }))
      .filter((g) => g.commits.length > 0);
    return {
      answer,
      commits: commitGroups.flatMap((g) => g.commits),
      commitGroups,
      snippets: [...surfacedSnippets.values()],
    };
  };
  const surfacedSnippets = new Map<string, DiscordSnippet>();
  const collectSnippets = (ss: DiscordSnippet[]) => {
    for (const s of ss) surfacedSnippets.set(snippetKey(s), s);
  };

  // Open the agent-trace run (no-op when no runId). Best-effort throughout.
  await startRun(repoId, runId, 'askRepo');

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      logger.info('askRepoFlow: round', { repoId, round });
      const completion = await openai.chat.completions.create({
        model: MODELS.fast,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
      });

      const choice = completion.choices[0]?.message;
      if (!choice) throw new HttpsError('internal', 'OpenAI returned no message');
      messages.push(choice);

      const toolCalls = choice.tool_calls ?? [];
      if (toolCalls.length === 0) {
        await finishRun(repoId, runId, 'done');
        return buildResult(choice.content ?? '');
      }

      const results = await Promise.all(
        toolCalls.map((call) => runTool(repoId, call, sinceKey, today, {
          collectCommits,
          collectSnippets,
        })),
      );
      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }

      // One batch trace write per round — a step per tool the round executed.
      await appendStep(repoId, runId, results.map((r) => r.label));
    }

    // Out of rounds — force one final answer with no tools.
    logger.warn('askRepoFlow: round limit hit, forcing final answer', { repoId });
    await appendStep(repoId, runId, TRACE_LABELS.composing);
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
    await finishRun(repoId, runId, 'done');
    return buildResult(finalCompletion.choices[0]?.message?.content ?? '');
  } catch (err) {
    // The flow failed (e.g. OpenAI down) — mark the run errored, then rethrow so
    // the handler still surfaces the failure to the client.
    await finishRun(repoId, runId, 'error');
    throw err;
  }
}

/** Execute one tool call, collect its sources, and return its trace label. */
async function runTool(
  repoId: string,
  call: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
  sinceKey: (days: number) => string,
  today: string,
  collect: {
    collectCommits: (cs: DayCommit[], groupLabel: string) => void;
    collectSnippets: (ss: DiscordSnippet[]) => void;
  },
): Promise<{ id: string; content: string; label: string }> {
  if (call.type !== 'function') {
    return { id: call.id, content: 'unsupported tool call', label: '' };
  }
  const args = safeParse(call.function.arguments);
  const name = call.function.name;
  switch (name) {
    case 'listDayCommits': {
      const all = await listRangeCommits(repoId, sinceKey(clampDays(args.days)), today);
      // Optional in-memory filters (no Firestore composite index needed). Each
      // filtered call becomes its own labeled window so a project-wide question
      // can be split per person / per task instead of one mixed list.
      const authorLogin =
        typeof args.authorLogin === 'string' ? args.authorLogin.trim() : '';
      const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
      let cs = all;
      let label = '';
      if (authorLogin) {
        // FUZZY author match: GitHub logins often carry a suffix (e.g. the user
        // says "opal" but the login is "opaL1022"), and people refer to others
        // by display name. Match case-insensitively, preferring an exact login
        // hit but falling back to a substring of EITHER login or display name so
        // a partial / informal name still resolves.
        const q = authorLogin.toLowerCase();
        const exact = all.filter((c) => c.authorLogin.toLowerCase() === q);
        cs = exact.length
          ? exact
          : all.filter(
              (c) =>
                c.authorLogin.toLowerCase().includes(q) ||
                c.authorName.toLowerCase().includes(q),
            );
        // Prefer the human name (from the matched commits) for the window label.
        label = cs.find((c) => c.authorName)?.authorName || authorLogin;
      } else if (taskId) {
        cs = all.filter((c) => c.linkedTaskIds.includes(taskId));
        label = `Task ${taskId}`;
      }
      collect.collectCommits(cs, label); // surfaced to the panel (capped per window)
      return { id: call.id, content: JSON.stringify(cs), label: TRACE_LABELS.listDayCommits };
    }
    case 'listCompletedTasks': {
      const ts = await listRangeCompletedTasks(repoId, sinceKey(clampDays(args.days)), today);
      return { id: call.id, content: JSON.stringify(ts), label: TRACE_LABELS.listCompletedTasks };
    }
    case 'listRangeDigests': {
      const ds = await listRangeDigests(repoId, sinceKey(clampDays(args.days)), today);
      return { id: call.id, content: JSON.stringify(ds), label: TRACE_LABELS.listRangeDigests };
    }
    case 'searchPastCommits': {
      const query = String(args.query ?? '');
      const cs = await searchPastCommits(
        repoId,
        query,
        typeof args.limit === 'number' ? args.limit : 8,
      );
      // Search results are their own window, labeled by the query.
      collect.collectCommits(cs, query ? `“${query}”` : '');
      return { id: call.id, content: JSON.stringify(cs), label: TRACE_LABELS.searchPastCommits };
    }
    case 'searchDiscordMessages': {
      const ss = await searchDiscordMessages(repoId, String(args.query ?? ''));
      collect.collectSnippets(ss);
      return { id: call.id, content: JSON.stringify(ss), label: TRACE_LABELS.searchDiscordMessages };
    }
    case 'getCommitDiff': {
      // Real per-file diff for ONE commit, so the agent can ground "what changed"
      // in the actual patch instead of paraphrasing the one-line aiSummary.
      // best-effort (null → diff unavailable); not collected into a source panel.
      const diff = await getCommitDiff(repoId, String(args.sha ?? '').trim());
      return {
        id: call.id,
        content: JSON.stringify(diff ?? { error: 'diff unavailable for this sha' }),
        label: TRACE_LABELS.getCommitDiff,
      };
    }
    case 'readRepoPlanningDocs': {
      const docs = await readRepoPlanningDocs(repoId);
      return { id: call.id, content: JSON.stringify(docs.content), label: TRACE_LABELS.readRepoPlanningDocs };
    }
    case 'getTaskDependents': {
      // getTaskDependents/readTeamState can throw (unlike the dailyIntel tools);
      // degrade to an empty result so one failed signal never kills the answer.
      const ds = await getTaskDependents(repoId, String(args.taskId ?? '')).catch((err) => {
        logger.warn('askRepoFlow: getTaskDependents failed (best-effort)', { repoId, err: String(err) });
        return [];
      });
      return { id: call.id, content: JSON.stringify(ds), label: TRACE_LABELS.getTaskDependents };
    }
    case 'readTeamState': {
      const roster = await readTeamState(repoId)
        .then((rs) => rs.map((m) => ({ name: m.name, githubLogin: m.githubLogin })))
        .catch((err) => {
          logger.warn('askRepoFlow: readTeamState failed (best-effort)', { repoId, err: String(err) });
          return [];
        });
      return { id: call.id, content: JSON.stringify(roster), label: TRACE_LABELS.readTeamState };
    }
    default:
      return { id: call.id, content: `unknown tool ${name}`, label: '' };
  }
}

/**
 * Planner pre-step: ask a cheap model to restate the question as a structured
 * AskRepoPlan, then render it as a guidance block for the main loop. BEST-EFFORT
 * — any failure (parse/network/empty) returns '' so the flow is unchanged. The
 * planner sees the recent history too, so follow-ups ("and what about her?")
 * resolve against context.
 */
async function planQuery(
  openai: ReturnType<typeof getOpenAI>,
  today: string,
  question: string,
  history: AskRepoTurn[],
): Promise<string> {
  try {
    const completion = await openai.beta.chat.completions.parse({
      model: MODELS.fast,
      messages: [
        { role: 'system', content: askRepoPlannerSystem(today) },
        ...history
          .slice(-MAX_HISTORY_TURNS)
          .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && t.content)
          .map((t) => ({ role: t.role, content: t.content })),
        { role: 'user', content: question },
      ],
      response_format: zodResponseFormat(AskRepoPlanSchema, 'queryPlan'),
    });
    const plan = (completion.choices[0]?.message?.parsed as AskRepoPlan | null) ?? null;
    return plan ? formatPlanForPrompt(plan) : '';
  } catch (err) {
    logger.warn('askRepoFlow: planner failed (best-effort)', {
      err: String(err),
    });
    return '';
  }
}

function safeParse(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
