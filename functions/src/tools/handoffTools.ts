// Read-only data-access tools for the agentic generateHandoffFlow (Phase 1).
//
// Mirrors tools/assignTools.ts / tools/dailyIntel.ts: thin pure async functions,
// no `onCall` wrapper, NEVER call OpenAI, BEST-EFFORT — any Firestore/GitHub
// failure degrades to an empty/null result + a `logger.warn`, never an
// HttpsError (Rule D). The OpenAI tool schemas + dispatcher live in the flow
// (flows/generateHandoff.ts), like assignTask's TOOLS + runReadTool; the raw
// data access lives here.
import { logger } from 'firebase-functions/v2';

import { db } from '../admin';
import { getCommitDiff as ghGetCommitDiff } from '../services/githubClient';
import { resolveRepoContext } from './repoDocs';

/** One commit linked to a task, trimmed for the drafting agent. */
export interface RelatedCommit {
  sha: string;
  subject: string;
  aiSummary: string | null;
  author: string;
  filesChanged: number;
}

/** Caps so the tool result stays bounded regardless of repo size. */
const COMMITS_PER_TASK = 6;
const MAX_COMMITS = 15;
/** Per-commit diff budget (~3000 tokens at ~4 chars/token) — prd MAX_PATCH_CHARS. */
export const MAX_PATCH_CHARS = 12000;

/**
 * Lists the commits linked (via `#N` refs, parsed by onCommitCreated into
 * `linkedTaskIds`) to any of `taskIds` — the real work behind the prerequisites.
 * Deduped across ids, newest-first, capped. Best-effort: a failing query (e.g. a
 * missing array-contains + orderBy composite index) is logged and skipped rather
 * than failing the whole handoff (Rule D).
 */
export async function listRelatedCommits(
  repoId: string,
  taskIds: string[],
): Promise<RelatedCommit[]> {
  const seenSha = new Set<string>();
  const commits: RelatedCommit[] = [];
  for (const id of taskIds) {
    if (commits.length >= MAX_COMMITS) break;
    try {
      const snap = await db
        .collection(`apps/gitsync/repos/${repoId}/commits`)
        .where('linkedTaskIds', 'array-contains', id)
        .orderBy('committedAt', 'desc')
        .limit(COMMITS_PER_TASK)
        .get();
      for (const doc of snap.docs) {
        if (seenSha.has(doc.id) || commits.length >= MAX_COMMITS) continue;
        seenSha.add(doc.id);
        const c = doc.data() ?? {};
        const author = (c.author as Record<string, unknown> | undefined) ?? {};
        commits.push({
          sha: doc.id.slice(0, 7),
          subject: ((c.message as string | undefined) ?? '').split('\n')[0],
          aiSummary: (c.aiSummary as string | undefined) ?? null,
          author:
            (author.name as string | undefined) ??
            (author.login as string | undefined) ??
            'unknown',
          filesChanged: ((c.filesChanged as string[] | undefined) ?? []).length,
        });
      }
    } catch (err) {
      // array-contains + orderBy may need a composite index that isn't deployed
      // — degrade gracefully rather than failing the whole handoff (Rule D).
      logger.warn('handoffTools.listRelatedCommits: query failed (best-effort)', {
        repoId,
        taskId: id,
        err: String(err),
      });
    }
  }
  return commits;
}

/**
 * Fetches ONE commit's unified diff (per-file patches, truncated to
 * {@link MAX_PATCH_CHARS}) via the repo owner's GitHub token. Best-effort:
 * returns null when the repo context can't be resolved (no slug / owner token /
 * private repo) or the GitHub call fails — the agent can still draft from commit
 * subjects + summaries + Discord + planning docs (prd R6). Only invoked when the
 * agent names a sha, so GitHub is hit sparingly (cost guard).
 */
export async function getCommitDiff(
  repoId: string,
  sha: string,
): Promise<import('../services/githubClient').CommitDiff | null> {
  try {
    const ctx = await resolveRepoContext(repoId);
    if (!ctx) {
      logger.info('handoffTools.getCommitDiff: no repo context; null', {
        repoId,
      });
      return null;
    }
    return await ghGetCommitDiff(
      ctx.owner,
      ctx.repo,
      ctx.token,
      sha,
      MAX_PATCH_CHARS,
    );
  } catch (err) {
    logger.warn('handoffTools.getCommitDiff: failed (best-effort)', {
      repoId,
      sha,
      err: String(err),
    });
    return null;
  }
}
