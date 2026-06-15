// triagePr — PR triage agent core logic.
//
// Pure flow (no Firestore writes, no Discord call): given a PR's repo +
// metadata + a GitHub access token, returns the triage payload
// (summary + 2 recommended reviewers + risk tags). The trigger
// (`triggers/onPullRequestOpened`) persists the payload on
// `pullRequests/{n}` and dispatches the Discord notification.
//
// Reviewer recommendation answers the question "who has historically touched
// these files?", so it queries GitHub's per-path commit list and tallies
// committers (recency-weighted by GitHub's default newest-first ordering). It
// is deliberately NOT the existing `searchMemberCommits()` (which is semantic
// over commit messages by a *given* author — the wrong direction).
//
// The flow returns exactly TWO reviewers: the top-tallied historical committers
// mapped back to repo members via readTeamState; ties broken by most-recent
// touch. The persisting trigger writes these onto pullRequests/{n}.
import { logger } from 'firebase-functions/v2';

import { db } from '../admin';
import { getOpenAI, MODELS } from '../config';
import { buildSystemPrompt } from '../prompts/baseSystem';
import { readTeamState } from '../tools/assignTools';
import {
  listCommitsForPath,
  listPullRequestFiles,
  type PullRequestFile,
} from '../services/githubClient';

export interface TriagePrInput {
  repoId: string;
  prNumber: number;
  prAuthorLogin: string;
  title: string;
  body: string;
  owner: string;
  repo: string;
  accessToken: string;
}

export interface RecommendedReviewer {
  userId: string;
  githubLogin: string | null;
  discordUserId: string | null;
}

/**
 * Per-pick scoring breakdown — persisted on the pullRequests doc alongside
 * the existing triage fields so future-you can retune the load weights from
 * real data without rerunning. Pure observability; not consumed by the UI.
 */
export interface ReviewerScoreBreakdown {
  userId: string;
  /** Raw file-history score (sum of 1/(rank+1) over the top changed files). */
  rawScore: number;
  /** Blended load = recentPicks + ACTIVE_ISSUE_LOAD_WEIGHT × activeIssueCount. */
  load: number;
  /** Multiplicative penalty = 1 / (1 + LOAD_LAMBDA × load). */
  loadPenalty: number;
  /** rawScore × loadPenalty — the value used for ranking. */
  finalScore: number;
  /** Which slot this candidate filled (1 = expert, 2 = apprentice). */
  slot: 1 | 2;
}

export interface TriagePrResult {
  summary: string;
  recommendedReviewers: RecommendedReviewer[];
  reviewerScores: ReviewerScoreBreakdown[];
  riskTags: string[];
}

/** PR is "large" when total touched lines exceed this. Tag-only, no behavior change. */
const LARGE_DIFF_THRESHOLD = 300;
/** Per-file commit-history page size when ranking reviewers. */
const PATH_HISTORY_PER_PAGE = 10;
/** Cap the per-file GitHub round-trips — top N files by churn. */
const TOP_FILES_FOR_REVIEWERS = 10;
/** Number of reviewer recommendations to return. */
const REVIEWER_PICK_COUNT = 2;
/** Patch chars sent to the LLM per file (keeps prompt under ~2K tokens). */
const PATCH_PREVIEW_CHARS = 600;

// --- Workload-aware tuning knobs (A+D — 06-13) -----------------------------
// All in one place so retuning is a one-line edit. λ controls how aggressively
// load suppresses an otherwise-strong candidate; the active-issue weight folds
// task-assignment workload into the same "load" signal as triage picks.
/** Multiplicative penalty steepness: penalty = 1 / (1 + λ × load). */
const LOAD_LAMBDA = 0.3;
/** How much an open task assignment counts vs. one recent triage pick. */
const ACTIVE_ISSUE_LOAD_WEIGHT = 0.25;
/** How far back "recent triage picks" looks (days). */
const LOAD_WINDOW_DAYS = 14;
/** Hard cap on the per-repo PR scan (newest first). */
const LOAD_RECENT_PR_CAP = 50;
/** Slot-2 freshness filter looks at the most recent N triaged PRs. */
const FRESHNESS_WINDOW_PRS = 5;
/** Slot 2 only fills if the candidate's raw file-history score clears this. */
const SLOT_2_SCORE_FLOOR = 0.5;

/**
 * Deterministic risk tags. Cheap, no LLM cost; high-signal hints for
 * reviewers. Path predicates are intentionally conservative — false positives
 * are fine (a banner tag in a Discord post), false negatives are not.
 */
export function computeRiskTags(files: PullRequestFile[]): string[] {
  const tags: string[] = [];
  const totalChurn = files.reduce(
    (n, f) => n + f.additions + f.deletions,
    0,
  );
  if (totalChurn > LARGE_DIFF_THRESHOLD) tags.push('large-diff');
  if (files.some((f) => f.filename.startsWith('functions/'))) {
    tags.push('touches-functions');
  }
  if (
    files.some(
      (f) =>
        f.filename === 'firestore.rules' ||
        f.filename === 'firestore.indexes.json',
    )
  ) {
    tags.push('touches-rules');
  }
  if (
    files.some(
      (f) =>
        /(^|\/)migrations\//.test(f.filename) ||
        /(^|\/)schema\//.test(f.filename),
    )
  ) {
    tags.push('touches-schema');
  }
  return tags;
}

/**
 * Tally committers across the top-churn files, weighted by recency rank.
 * The `repos.listCommits({path})` API returns newest-first, so a per-file
 * rank-N commit scores `1/(N+1)` — recent contributors dominate, but a
 * long-standing maintainer still surfaces. PR author is excluded.
 */
async function tallyCommittersByPath(
  input: TriagePrInput,
  topFiles: PullRequestFile[],
): Promise<Map<string, number>> {
  const scoreByLogin = new Map<string, number>();
  const lowerAuthor = input.prAuthorLogin.toLowerCase();

  for (const file of topFiles) {
    let commits;
    try {
      commits = await listCommitsForPath(
        input.owner,
        input.repo,
        input.accessToken,
        file.filename,
        PATH_HISTORY_PER_PAGE,
      );
    } catch (err) {
      // A single file's history may 404 (rename / removed). Skip, don't fail
      // the whole triage — we still have signal from the other files.
      logger.warn('triagePr: listCommitsForPath failed (skipping file)', {
        repoId: input.repoId,
        prNumber: input.prNumber,
        path: file.filename,
        err: String(err),
      });
      continue;
    }
    commits.forEach((c, rank) => {
      const login = c.authorLogin.toLowerCase();
      if (!login || login === lowerAuthor) return;
      scoreByLogin.set(login, (scoreByLogin.get(login) ?? 0) + 1 / (rank + 1));
    });
  }
  return scoreByLogin;
}

/**
 * Result of {@link recentTriageLoad} — read once per triage, passed in to
 * {@link pickReviewers} so that function stays pure (testable without
 * Firestore mocks).
 */
export interface RecentTriageLoad {
  /** userId → number of times they were a recommended reviewer in the window. */
  picksByUserId: Map<string, number>;
  /**
   * `recommendedReviewers` arrays of the most recent {@link FRESHNESS_WINDOW_PRS}
   * triaged PRs (each as a Set<userId>). The slot-2 picker avoids candidates
   * present in ANY of these sets to rotate reviewers.
   */
  recentReviewerSets: Set<string>[];
}

/**
 * Reads recent triage outcomes on this repo to feed the workload-aware picker.
 * One Firestore query (~50 docs, cheap) — best-effort: returns empty load on
 * any failure so a new repo (no PRs yet) or a transient outage doesn't break
 * triage.
 *
 * NOTE: we filter on `triagedAt > <14d ago>` rather than `triagedAt != null`
 * because Firestore's `!=` requires composite indexes the project doesn't
 * carry. Range filter + ordered limit gives the same selection cheaper.
 */
export async function recentTriageLoad(
  repoId: string,
): Promise<RecentTriageLoad> {
  const since = new Date(Date.now() - LOAD_WINDOW_DAYS * 86_400_000);
  let docs;
  try {
    const snap = await db
      .collection(`apps/gitsync/repos/${repoId}/pullRequests`)
      .where('triagedAt', '>', since)
      .orderBy('triagedAt', 'desc')
      .limit(LOAD_RECENT_PR_CAP)
      .get();
    docs = snap.docs;
  } catch (err) {
    logger.warn('triagePr: recentTriageLoad failed (empty load)', {
      repoId,
      err: String(err),
    });
    return { picksByUserId: new Map(), recentReviewerSets: [] };
  }

  const picksByUserId = new Map<string, number>();
  const recentReviewerSets: Set<string>[] = [];

  docs.forEach((d, idx) => {
    const data = d.data() ?? {};
    const reviewers = Array.isArray(data.recommendedReviewers)
      ? (data.recommendedReviewers as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        )
      : [];
    for (const uid of reviewers) {
      picksByUserId.set(uid, (picksByUserId.get(uid) ?? 0) + 1);
    }
    if (idx < FRESHNESS_WINDOW_PRS) {
      recentReviewerSets.push(new Set(reviewers));
    }
  });

  return { picksByUserId, recentReviewerSets };
}

/**
 * Maps tallied GitHub logins → roster members and ranks them with a
 * workload-aware multiplicative penalty (A+D design, 06-13):
 *
 *   finalScore = fileHistoryScore × 1 / (1 + λ × load)
 *   load       = recentPicks(14d) + ACTIVE_ISSUE_LOAD_WEIGHT × activeIssueCount
 *
 * Slot 1 ("expert") is the head of the sorted candidates. Slot 2
 * ("apprentice") prefers a candidate not present in any of the last
 * {@link FRESHNESS_WINDOW_PRS} reviewer sets — falling back to the next-highest
 * `finalScore` candidate if the freshness filter empties the pool. Slot 2 is
 * skipped entirely if its raw `fileHistoryScore` is below
 * {@link SLOT_2_SCORE_FLOOR} (better one correct pick than a rubber stamp).
 *
 * Pure function — Firestore reads happen ONCE in the caller via
 * {@link recentTriageLoad}, so the existing test suite continues to work
 * without DB mocks.
 */
export async function pickReviewers(
  repoId: string,
  prAuthorLogin: string,
  scoreByLogin: Map<string, number>,
  load: RecentTriageLoad,
): Promise<{
  reviewers: RecommendedReviewer[];
  scores: ReviewerScoreBreakdown[];
}> {
  if (scoreByLogin.size === 0) return { reviewers: [], scores: [] };

  let roster;
  try {
    roster = await readTeamState(repoId);
  } catch (err) {
    logger.warn('triagePr: readTeamState failed (no reviewers)', {
      repoId,
      err: String(err),
    });
    return { reviewers: [], scores: [] };
  }

  const lowerAuthor = prAuthorLogin.toLowerCase();
  const candidates = roster
    .filter((m) => m.githubLogin)
    .filter((m) => m.githubLogin!.toLowerCase() !== lowerAuthor)
    .map((m) => {
      const rawScore = scoreByLogin.get(m.githubLogin!.toLowerCase()) ?? 0;
      const recentPicks = load.picksByUserId.get(m.userId) ?? 0;
      const memberLoad =
        recentPicks + ACTIVE_ISSUE_LOAD_WEIGHT * m.activeIssueCount;
      const loadPenalty = 1 / (1 + LOAD_LAMBDA * memberLoad);
      const finalScore = rawScore * loadPenalty;
      return { member: m, rawScore, load: memberLoad, loadPenalty, finalScore };
    })
    .filter((c) => c.rawScore > 0);

  // Sort by finalScore desc — load is already folded in, so no secondary key.
  // (Ties on finalScore are vanishingly rare with the float blend; any ordering
  // among them is fine.)
  candidates.sort((a, b) => b.finalScore - a.finalScore);

  if (candidates.length === 0) return { reviewers: [], scores: [] };

  const picked: typeof candidates = [];
  const scores: ReviewerScoreBreakdown[] = [];

  // Slot 1: the head.
  const slot1 = candidates[0];
  picked.push(slot1);
  scores.push({
    userId: slot1.member.userId,
    rawScore: slot1.rawScore,
    load: slot1.load,
    loadPenalty: slot1.loadPenalty,
    finalScore: slot1.finalScore,
    slot: 1,
  });

  if (REVIEWER_PICK_COUNT >= 2 && candidates.length >= 2) {
    const recentUnion = new Set<string>();
    for (const s of load.recentReviewerSets) for (const u of s) recentUnion.add(u);

    // Skip the slot-1 pick; among the rest, prefer freshness then fall back
    // to next-highest finalScore.
    const remaining = candidates.slice(1);
    const fresh = remaining.find((c) => !recentUnion.has(c.member.userId));
    const slot2 = fresh ?? remaining[0];

    // Quality floor: better to return 1 reviewer than rubber-stamp slot 2.
    if (slot2 && slot2.rawScore >= SLOT_2_SCORE_FLOOR) {
      picked.push(slot2);
      scores.push({
        userId: slot2.member.userId,
        rawScore: slot2.rawScore,
        load: slot2.load,
        loadPenalty: slot2.loadPenalty,
        finalScore: slot2.finalScore,
        slot: 2,
      });
    }
  }

  const reviewers = picked.map((c) => ({
    userId: c.member.userId,
    githubLogin: c.member.githubLogin,
    discordUserId: c.member.discordUserId,
  }));
  return { reviewers, scores };
}

/**
 * One LLM call (gpt-4o-mini) — short prompt, deterministic system message,
 * 3–5 line plain summary. Best-effort: returns "" on failure so the rest of
 * the triage (reviewers + tags) still lands.
 */
async function summarizeDiff(
  input: TriagePrInput,
  files: PullRequestFile[],
): Promise<string> {
  // File list with a tiny patch preview each — enough for "what's the intent",
  // not enough to blow the token budget.
  const filesBlock = files
    .slice(0, TOP_FILES_FOR_REVIEWERS)
    .map((f) => {
      const header = `${f.filename}  (+${f.additions} −${f.deletions})`;
      if (!f.patch) return header;
      const preview = f.patch.slice(0, PATCH_PREVIEW_CHARS);
      return `${header}\n${preview}`;
    })
    .join('\n\n');

  const prompt =
    `PR title: ${input.title}\n\n` +
    `PR description:\n${input.body || '(empty)'}\n\n` +
    `Changed files (top ${TOP_FILES_FOR_REVIEWERS} by churn):\n${filesBlock}`;

  try {
    const completion = await getOpenAI().chat.completions.create({
      model: MODELS.fast,
      messages: [
        {
          role: 'system',
          content: buildSystemPrompt({
            agentBody:
              'Your task: summarize a GitHub pull request for teammates who ' +
              'need to decide whether to review it. Reply with 3–5 short lines ' +
              "(plain text, no bullets, no headers). Focus on the PR's INTENT " +
              'and any unusual concerns. Do NOT restate the file list — the ' +
              'reader already has it.',
          }),
        },
        { role: 'user', content: prompt },
      ],
    });
    return completion.choices[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    logger.warn('triagePr: summarizeDiff failed (returning empty)', {
      repoId: input.repoId,
      prNumber: input.prNumber,
      err: String(err),
    });
    return '';
  }
}

/**
 * Top-level entry. Always resolves to a `TriagePrResult` — empty fields
 * on degraded paths rather than throwing, so the trigger can always persist
 * the partial outcome and mark `triagedAt`.
 */
export async function triagePr(input: TriagePrInput): Promise<TriagePrResult> {
  let files: PullRequestFile[];
  try {
    files = await listPullRequestFiles(
      input.owner,
      input.repo,
      input.accessToken,
      input.prNumber,
    );
  } catch (err) {
    // No files = no signal for reviewers + no diff for the summary. We still
    // resolve (empty) so the trigger can mark triagedAt and not loop.
    logger.warn('triagePr: listPullRequestFiles failed (empty result)', {
      repoId: input.repoId,
      prNumber: input.prNumber,
      err: String(err),
    });
    return {
      summary: '',
      recommendedReviewers: [],
      reviewerScores: [],
      riskTags: [],
    };
  }

  const riskTags = computeRiskTags(files);

  // Reviewer ranking only needs the high-churn files (per-file GitHub round
  // trip is the rate-limit cost), but the summary should see all files'
  // headers for completeness.
  const topByChurn = [...files]
    .sort(
      (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
    )
    .slice(0, TOP_FILES_FOR_REVIEWERS);

  // Workload signal — one Firestore read per triage, run in parallel with the
  // GitHub history + OpenAI calls.
  const [scoreByLogin, summary, load] = await Promise.all([
    tallyCommittersByPath(input, topByChurn),
    summarizeDiff(input, files),
    recentTriageLoad(input.repoId),
  ]);

  const { reviewers: recommendedReviewers, scores: reviewerScores } =
    await pickReviewers(
      input.repoId,
      input.prAuthorLogin,
      scoreByLogin,
      load,
    );

  return { summary, recommendedReviewers, reviewerScores, riskTags };
}
