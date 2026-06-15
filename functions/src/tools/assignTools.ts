// Reusable tool helpers for assignTaskFlow (ARCHITECTURE §5.2).
//
// These are the data-access primitives the agentic loop exposes to OpenAI as
// function tools. Each is kept thin: read Firestore (joining members + users
// where needed), normalize, return a plain JSON-serializable shape. The flow
// (flows/assignTask.ts) owns the loop, the OpenAI calls, and the finalize
// write — these helpers never call OpenAI and never mutate state.
import { logger } from 'firebase-functions/v2';
import { db } from '../admin';
import { embed } from './embedding';

/** One member as the assign agent sees them: workload (members doc) joined
 *  with identity + expertise (users doc). The 3-way id map (userId /
 *  githubLogin / discordUserId) is intentional — see prd.md "Future / TODO". */
export interface TeamMemberState {
  userId: string;
  name: string | null;
  githubLogin: string | null;
  discordUserId: string | null;
  activeIssueCount: number;
  expertiseTags: string[];
  lastActiveAt: unknown;
}

/**
 * List every member of a repo, joining `repos/{repoId}/members/{userId}`
 * (workload) with `users/{userId}` (identity + expertise). Members with a
 * missing users doc still appear (identity fields null) so the agent never
 * silently loses a candidate.
 */
export async function readTeamState(repoId: string): Promise<TeamMemberState[]> {
  const membersSnap = await db
    .collection(`apps/gitsync/repos/${repoId}/members`)
    .get();

  return Promise.all(
    membersSnap.docs.map(async (m) => {
      const member = m.data() ?? {};
      const userSnap = await db.doc(`apps/gitsync/users/${m.id}`).get();
      const user = userSnap.data() ?? {};
      return {
        userId: m.id,
        name: (user.name as string | undefined) ?? null,
        githubLogin: (user.githubLogin as string | undefined) ?? null,
        discordUserId: (user.discordUserId as string | undefined) ?? null,
        activeIssueCount: (member.activeIssueCount as number | undefined) ?? 0,
        expertiseTags: (user.expertiseTags as string[] | undefined) ?? [],
        lastActiveAt: member.lastActiveAt ?? null,
      };
    }),
  );
}

/** A commit snippet returned to the agent for relevance reasoning. */
export interface MemberCommitHit {
  sha: string;
  message: string;
}

/**
 * Semantic search over a single member's past commits. Resolves
 * `memberId (userId) → githubLogin` via the users doc, then runs a Firestore
 * vector `findNearest` over the repo's commits, PREFILTERED by
 * `repoId == repoId AND author.login == githubLogin` (the repoId prefilter is
 * mandatory — see database-guidelines vector section). Tolerates a member with
 * no githubLogin or no commits by returning [].
 *
 * BEST-EFFORT (Rule D spirit): commit semantic search is only ONE of four
 * assignment signals (workload / expertise / dependents are the others). The
 * embedding + `findNearest` region is wrapped in try/catch so an embedding
 * failure or a missing vector index (`9 FAILED_PRECONDITION`) degrades to `[]`
 * + a `logger.warn` rather than throwing and killing the whole assignTaskFlow.
 * This function NEVER throws — worst case it returns [].
 */
export async function searchMemberCommits(
  repoId: string,
  memberId: string,
  query: string,
): Promise<MemberCommitHit[]> {
  const userSnap = await db.doc(`apps/gitsync/users/${memberId}`).get();
  const githubLogin = userSnap.data()?.githubLogin as string | undefined;
  if (!githubLogin) return []; // can't map to commits → no signal

  try {
    const queryVector = await embed(query);
    const snap = await db
      .collection(`apps/gitsync/repos/${repoId}/commits`)
      .where('repoId', '==', repoId)
      .where('author.login', '==', githubLogin)
      .findNearest({
        vectorField: 'messageEmbedding',
        queryVector,
        limit: 5,
        distanceMeasure: 'COSINE',
      })
      .get();

    return snap.docs.map((d) => ({
      sha: d.id,
      message: (d.data()?.message as string | undefined) ?? '',
    }));
  } catch (err) {
    // Optional/slow signal failed (embedding error, missing vector index, etc.).
    // Degrade to no commit signal — the agent still has workload/expertise/dependents.
    logger.warn('searchMemberCommits failed; returning [] (best-effort)', {
      repoId,
      memberId,
      githubLogin,
      err: String(err),
    });
    return [];
  }
}

/** Max skill tags kept per member (oldest-first eviction beyond this). */
export const MAX_TAGS = 8;

/**
 * Merge AI-learned skill tags into a member's `expertiseTags` (W3b). The next
 * `assignTaskFlow` reads them back via `readTeamState` — the agent's last
 * decision becomes its next input.
 *
 * Writes to `apps/gitsync/users/{userId}.expertiseTags` (the SAME field
 * readTeamState reads — NOT the members doc). Uses `set(...,{merge:true})`, not
 * `update()`, because the users doc may not pre-exist for a member (readTeamState
 * tolerates its absence); `update()` would throw NOT_FOUND.
 *
 * Set-union with a deterministic cap: keep existing tags first, append only new
 * ones, then if over MAX_TAGS drop from the FRONT (oldest) so the newest stay.
 *
 * BEST-EFFORT — a write failure is logged and swallowed (the assignment already
 * applied). NEVER throws.
 */
export async function mergeLearnedTags(
  repoId: string,
  userId: string,
  newTags: string[],
): Promise<void> {
  const clean = [
    ...new Set(
      newTags
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0 && t.length <= 30),
    ),
  ];
  if (clean.length === 0) return;

  try {
    const snap = await db.doc(`apps/gitsync/users/${userId}`).get();
    const existing = (snap.data()?.expertiseTags as string[] | undefined) ?? [];

    const merged = [...existing];
    for (const t of clean) if (!merged.includes(t)) merged.push(t);
    const capped =
      merged.length > MAX_TAGS ? merged.slice(merged.length - MAX_TAGS) : merged;

    await db
      .doc(`apps/gitsync/users/${userId}`)
      .set({ expertiseTags: capped }, { merge: true });
  } catch (err) {
    // The assignment already applied — never fail the flow over a learning signal.
    logger.warn('mergeLearnedTags failed (best-effort)', {
      repoId,
      userId,
      err: String(err),
    });
  }
}

/** A downstream task blocked by the task being assigned. */
export interface TaskDependent {
  taskId: string;
  title: string;
}

/**
 * Tasks that declare `taskId` in their `dependsOn` array — i.e. who is blocked
 * until this task ships. Used by the agent to prefer an assignee who unblocks
 * the most downstream work.
 */
export async function getTaskDependents(
  repoId: string,
  taskId: string,
): Promise<TaskDependent[]> {
  const snap = await db
    .collection(`apps/gitsync/repos/${repoId}/tasks`)
    .where('dependsOn', 'array-contains', taskId)
    .get();

  return snap.docs.map((d) => ({
    taskId: d.id,
    title: (d.data()?.title as string | undefined) ?? '',
  }));
}
