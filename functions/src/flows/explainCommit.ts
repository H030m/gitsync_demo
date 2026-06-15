// explainCommitFlow — "tap a commit on the tree map, get an AI explanation of
// the work". AGENTIC: an OpenAI function-calling loop over read-only tools the
// model drives itself (searchDiscordMessages / listNeighborCommits /
// getCommitDiff), terminating in `writeExplanation(markdown)`. The result is
// cached on the commit doc (`workSummary`) so repeat taps are instant and free.
// Only Cloud Functions can write commits (clients are read-only), so the cache
// write happens here.
//
// A best-effort agent trace (`runId`) streams the loop's progress to the client
// (which subscribes to the agentRuns doc) so a tap shows live "thinking" steps —
// reading Discord, listing nearby commits, writing — instead of a bare spinner.
//
// Bounded by global caps (ROUNDS_CAP / MAX_TOOL_CALLS) so it always converges.
// The GitHub-fallback path (a branch-graph commit with no Firestore doc) stays a
// single OpenAI call — no linked tasks / neighbors / Discord scope to gather.
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import type OpenAI from 'openai';

import { db } from '../admin';
import { getOpenAI, MODELS } from '../config';
import { getCommit } from '../services/githubClient';
import { searchDiscordMessages } from '../tools/discordSearch';
import { getCommitDiff } from '../tools/handoffTools';
import {
  startRun,
  appendStep,
  finishRun,
  TRACE_LABELS,
} from '../tools/agentTrace';
import {
  explainCommitSystemPrompt,
  explainCommitSeedContext,
  explainCommitFallbackSystemPrompt,
  explainCommitFallbackContext,
} from '../prompts/explainCommit';

export interface ExplainCommitInput {
  repoId: string;
  sha: string;
  /** Regenerate even when a cached workSummary exists. */
  force?: boolean;
  /**
   * W6: optional human-readable English language NAME (e.g. "Traditional
   * Chinese") that forces the work summary into the user's app language on an
   * explicit recompute. Applies to both the doc path and the GitHub fallback
   * path. Absent/empty → unchanged behavior (the auto/first tap omits it).
   */
  language?: string;
  /** Client-generated agent-trace doc id; absent → the trace is a no-op. */
  runId?: string;
  /**
   * Optional GitHub fallback (06-05 D2): when the commit doc is missing (e.g. a
   * branch-graph commit predating all-branch ingest), fetch the commit from the
   * GitHub API instead of 404ing. Requires all three; the cache is NOT written
   * on this path (no doc to cache on).
   */
  owner?: string;
  repo?: string;
  accessToken?: string;
}

export interface ExplainCommitResult {
  markdown: string;
  cached: boolean;
}

/** How many of the author's neighboring commits we surface to the agent. */
const NEIGHBOR_LIMIT = 10;
/** How many linked tasks we resolve into the seed context. */
const TASK_LIMIT = 5;
/** How many discord snippets a search result is flattened/trimmed to. */
const MAX_DISCORD_MESSAGES = 16;

// ---- Agentic loop caps (mirrors generateHandoff) ---------------------------
/** Max model turns; hitting the last one forces a writeExplanation. */
const ROUNDS_CAP = 4;
/** Max total tool calls (cost guard); hitting it forces a write next turn. */
const MAX_TOOL_CALLS = 6;
/** Absolute hard ceiling on model turns — a safety net guaranteeing termination. */
const HARD_ROUND_CEILING = ROUNDS_CAP + 3;

// OpenAI tool schema for the drafting loop. `writeExplanation` ends it.
const EXPLAIN_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'searchDiscordMessages',
      description:
        "Semantic search the team's Discord for the discussion behind this " +
        'commit — the decision, blocker, or follow-up it relates to. Returns ' +
        'grouped message snippets.',
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
      name: 'listNeighborCommits',
      description:
        "List the author's neighboring commits (newest first) for narrative " +
        'context — what they were working on around this one. Cheap.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getCommitDiff',
      description:
        'Fetch this commit\'s unified diff (per-file patches, truncated). Use ' +
        'only when the message is too terse to explain the change. Defaults to ' +
        'this commit when sha is omitted.',
      parameters: {
        type: 'object',
        properties: {
          sha: { type: 'string', description: 'Commit sha (defaults to this one).' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'writeExplanation',
      description:
        'Submit your explanation as GitHub-flavored markdown. Ends the loop. ' +
        'Must follow the three-section format.',
      parameters: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: 'The full explanation markdown.' },
        },
        required: ['markdown'],
        additionalProperties: false,
      },
    },
  },
];

export async function explainCommitFlow(
  input: ExplainCommitInput,
): Promise<ExplainCommitResult> {
  const { repoId, sha, force, language, runId, owner, repo, accessToken } = input;

  const ref = db.doc(`apps/gitsync/repos/${repoId}/commits/${sha}`);
  const snap = await ref.get();
  if (!snap.exists) {
    // ---- GitHub fallback (06-05 D2) -----------------------------------------
    // No Firestore doc (branch-graph / historical commit predating all-branch
    // ingest). If we have GitHub creds, fetch the commit and summarize it from
    // that context — no linked tasks, no neighbors, no Discord, no cache write.
    if (owner && repo && accessToken) {
      return explainFromGitHub({ repoId, sha, owner, repo, accessToken, language });
    }
    throw new HttpsError('not-found', 'commit not found');
  }
  const commit = snap.data() ?? {};

  // ---- Cache hit: return the stored summary without an OpenAI call --------
  const cachedSummary = commit.workSummary as string | undefined;
  if (cachedSummary && !force) {
    return { markdown: cachedSummary, cached: true };
  }

  // ---- Seed context (minimal): the commit + its linked tasks. The agent
  // retrieves neighbors / discord / diff itself via tools. --------------------
  const author = (commit.author as Record<string, unknown> | undefined) ?? {};
  const authorLogin = (author.login as string | undefined) ?? '';
  const authorName =
    (author.name as string | undefined) ?? authorLogin ?? 'unknown';

  const linkedTaskIds = (
    (commit.linkedTaskIds as string[] | undefined) ?? []
  ).slice(0, TASK_LIMIT);
  const tasks = (
    await Promise.all(
      linkedTaskIds.map(async (id) => {
        try {
          const t = await db.doc(`apps/gitsync/repos/${repoId}/tasks/${id}`).get();
          const data = t.data() ?? {};
          return t.exists
            ? {
                title: (data.title as string | undefined) ?? '',
                status: (data.status as string | undefined) ?? '',
              }
            : null;
        } catch {
          return null;
        }
      }),
    )
  ).filter((t): t is { title: string; status: string } => t !== null);

  // Best-effort agent trace (no-op without a runId). Never affects control flow.
  await startRun(repoId, runId, 'explainCommit');

  const openai = getOpenAI();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: explainCommitSystemPrompt(language) },
    {
      role: 'user',
      content: explainCommitSeedContext({
        sha,
        message: (commit.message as string | undefined) ?? '',
        authorName,
        filesChanged: (commit.filesChanged as string[] | undefined) ?? [],
        additions: (commit.additions as number | undefined) ?? 0,
        deletions: (commit.deletions as number | undefined) ?? 0,
        aiSummary: (commit.aiSummary as string | undefined) ?? null,
        linkedTasks: tasks,
      }),
    },
  ];

  try {
    let markdown: string | null = null;
    let rounds = 0;
    let toolCalls = 0;

    while (markdown === null) {
      if (rounds >= HARD_ROUND_CEILING) {
        throw new HttpsError('internal', 'explainCommit did not converge');
      }
      const forceWrite = rounds >= ROUNDS_CAP - 1 || toolCalls >= MAX_TOOL_CALLS;

      const completion = await openai.chat.completions.create({
        model: MODELS.fast,
        messages,
        tools: EXPLAIN_TOOLS,
        tool_choice: forceWrite
          ? { type: 'function', function: { name: 'writeExplanation' } }
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
        // Model answered in prose instead of calling writeExplanation — accept
        // it as the explanation (like discordChat). Only nudge on an empty turn.
        const answer = (choice.content ?? '').trim();
        if (answer) {
          markdown = answer;
          break;
        }
        messages.push({
          role: 'user',
          content:
            'Call writeExplanation with your markdown, or a tool to gather evidence.',
        });
        continue;
      }

      // writeExplanation wins if present this turn (finalize precedence).
      const writeCall = calls.find(
        (c) => c.type === 'function' && c.function.name === 'writeExplanation',
      );
      if (writeCall && writeCall.type === 'function') {
        const args = safeParse(writeCall.function.arguments);
        markdown = String(args.markdown ?? '').trim();
        for (const c of calls) {
          messages.push({
            role: 'tool',
            tool_call_id: c.id,
            content: c.id === writeCall.id ? 'ok' : 'superseded by writeExplanation',
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
          const content = await runExplainTool(
            repoId,
            sha,
            authorLogin,
            call.function.name,
            safeParse(call.function.arguments),
          );
          return { id: call.id, content };
        }),
      );
      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }

      // One batch trace write per tool round (best-effort, no-op without runId).
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

    if (!markdown) {
      throw new HttpsError('internal', 'OpenAI returned an empty explanation');
    }

    // ---- Cache write-back (best-effort — a failed write must not fail the call)
    try {
      await ref.update({
        workSummary: markdown,
        workSummaryGeneratedAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      logger.warn('explainCommit: cache write failed (best-effort)', {
        repoId,
        sha,
        err: String(err),
      });
    }

    await finishRun(repoId, runId, 'done');
    logger.info('explainCommit: generated', { repoId, sha, rounds, toolCalls });
    return { markdown, cached: false };
  } catch (err) {
    await finishRun(repoId, runId, 'error');
    throw err;
  }
}

// ---- Helpers ---------------------------------------------------------------

/** Execute a non-terminal read tool, returning a JSON string for the model. */
async function runExplainTool(
  repoId: string,
  sha: string,
  authorLogin: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'searchDiscordMessages': {
      const snippets = await searchDiscordMessages(repoId, String(args.query ?? ''));
      const flat = snippets
        .flatMap((s) => s.messages)
        .map((m) => ({ author: m.authorName, content: m.content }))
        .slice(0, MAX_DISCORD_MESSAGES);
      return JSON.stringify(flat);
    }
    case 'listNeighborCommits':
      return JSON.stringify(await listNeighborCommits(repoId, sha, authorLogin));
    case 'getCommitDiff':
      return JSON.stringify(
        await getCommitDiff(repoId, String(args.sha ?? sha)),
      );
    default:
      return `Error: unknown tool ${name}`;
  }
}

/**
 * The author's most recent commits around `sha` (excluding it), newest first.
 * Best-effort: a failing query degrades to `[]` rather than failing the loop.
 */
async function listNeighborCommits(
  repoId: string,
  sha: string,
  authorLogin: string,
): Promise<Array<{ sha: string; message: string }>> {
  if (!authorLogin) return [];
  try {
    const ns = await db
      .collection(`apps/gitsync/repos/${repoId}/commits`)
      .where('author.login', '==', authorLogin)
      .orderBy('committedAt', 'desc')
      .limit(NEIGHBOR_LIMIT + 1)
      .get();
    return ns.docs
      .filter((d) => d.id !== sha)
      .slice(0, NEIGHBOR_LIMIT)
      .map((d) => ({
        sha: d.id.slice(0, 7),
        message: ((d.data()?.message as string | undefined) ?? '').split('\n')[0],
      }));
  } catch (err) {
    logger.warn('explainCommit: neighbor query failed (best-effort)', {
      repoId,
      sha,
      err: String(err),
    });
    return [];
  }
}

/**
 * Fallback summary path (06-05 D2): a single OpenAI call from the GitHub API
 * when no Firestore commit doc exists. Simpler context than the agentic path —
 * just message + files (no linked tasks, neighbors, or Discord) — and never
 * writes a cache (there is no doc to cache on).
 */
async function explainFromGitHub(input: {
  repoId: string;
  sha: string;
  owner: string;
  repo: string;
  accessToken: string;
  /** W6: forces the fallback explanation into the user's app language. */
  language?: string;
}): Promise<ExplainCommitResult> {
  const { repoId, sha, owner, repo, accessToken, language } = input;
  const detail = await getCommit(owner, repo, accessToken, sha);

  const completion = await getOpenAI().chat.completions.create({
    model: MODELS.fast,
    messages: [
      { role: 'system', content: explainCommitFallbackSystemPrompt(language) },
      {
        role: 'user',
        content: explainCommitFallbackContext({
          sha,
          message: detail.message,
          authorName: detail.authorName || detail.authorLogin || 'unknown',
          filesChanged: detail.files,
          additions: detail.additions,
          deletions: detail.deletions,
        }),
      },
    ],
  });
  const markdown = completion.choices[0]?.message?.content?.trim() ?? '';
  if (!markdown) {
    throw new HttpsError('internal', 'OpenAI returned an empty explanation');
  }

  logger.info('explainCommit: generated via GitHub fallback', { repoId, sha });
  return { markdown, cached: false };
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
