// agentTrace — a best-effort Firestore side-channel that records an agentic
// flow's live progress so the client can stream it WHILE the callable is still
// running (the callable itself only resolves at the end, so the trace can't ride
// the response). One doc per run at `repos/{repoId}/agentRuns/{runId}`:
//
//   { flow, status, steps: [{ label, at }], createdAt, updatedAt }
//
// The runId is CLIENT-GENERATED and passed in as a callable input, so the UI
// already holds it before the call and can subscribe to the doc immediately
// (see prd "runId handoff design").
//
// Design mirrors tools/projectBrief.ts / tools/repoDocs.ts:
//   - thin write helpers, no `onCall` wrapper, never calls OpenAI;
//   - BEST-EFFORT throughout — every helper swallows its own errors
//     (logger.warn) and NEVER throws, so a trace write can never fail the host
//     flow. A missing/invalid runId makes every helper a no-op (the handoff auto
//     trigger has no client and threads no runId).
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';

import { db } from '../admin';

/** Which agentic flow produced a run (the doc's `flow` field). */
export type AgentFlow =
  | 'askRepo'
  | 'generateHandoff'
  | 'discordChat'
  | 'explainCommit'
  | 'editDiscordDigest';

/** Human-readable English step labels, surfaced verbatim in the UI (the prd
 *  fixes them as English constants; the client does not translate them). */
export const TRACE_LABELS = {
  listDayCommits: 'Listing recent commits…',
  listCompletedTasks: 'Listing completed tasks…',
  listRangeDigests: 'Reading Discord digests…',
  searchPastCommits: 'Searching commit history…',
  searchDiscordMessages: 'Searching Discord…',
  readRepoPlanningDocs: 'Reading .trellis planning docs…',
  getTaskDependents: 'Checking task dependents…',
  readTeamState: 'Reading team roster…',
  // generateHandoff Phase-1 extras.
  listRelatedCommits: 'Listing related commits…',
  getCommitDiff: 'Reading a commit diff…',
  draftHandoff: 'Drafting the handoff…',
  composing: 'Composing answer…',
  // discordChat agentic loop.
  listDaySummaries: 'Listing day summaries…',
  getDaySummary: 'Reading a day digest…',
  // explainCommit agentic loop.
  listNeighborCommits: 'Listing nearby commits…',
  writeExplanation: 'Writing the explanation…',
  // editDiscordDigest agentic loop.
  writeDigest: 'Revising the digest…',
} as const;

/** Max accepted runId length + allowed charset (guards against path injection
 *  when the value comes straight from the callable input). */
const MAX_RUNID_LEN = 200;
const RUNID_RE = /^[A-Za-z0-9_-]+$/;

/** True when `runId` is a safe, non-empty doc id. A falsy/invalid id means the
 *  caller didn't request a trace (no-op every helper). */
function isValidRunId(runId: string | undefined): runId is string {
  return (
    typeof runId === 'string' &&
    runId.length > 0 &&
    runId.length <= MAX_RUNID_LEN &&
    RUNID_RE.test(runId)
  );
}

function runRef(repoId: string, runId: string) {
  return db.doc(`apps/gitsync/repos/${repoId}/agentRuns/${runId}`);
}

/**
 * Open a run doc: `{ flow, status:'running', steps:[], createdAt, updatedAt }`.
 * No-op on a missing/invalid runId. BEST-EFFORT — swallows errors, NEVER throws.
 */
export async function startRun(
  repoId: string,
  runId: string | undefined,
  flow: AgentFlow,
): Promise<void> {
  if (!isValidRunId(runId)) return;
  try {
    await runRef(repoId, runId).set({
      flow,
      status: 'running',
      steps: [],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    logger.warn('agentTrace.startRun failed (best-effort)', {
      repoId,
      runId,
      err: String(err),
    });
  }
}

/**
 * Append one or more progress steps in a SINGLE write (one batch per round —
 * see prd "write cadence"). Each label becomes a `{ label, at }` entry. No-op on
 * a missing/invalid runId or empty labels. BEST-EFFORT — NEVER throws.
 */
export async function appendStep(
  repoId: string,
  runId: string | undefined,
  labels: string | string[],
): Promise<void> {
  if (!isValidRunId(runId)) return;
  const list = (Array.isArray(labels) ? labels : [labels]).filter(
    (l) => typeof l === 'string' && l.length > 0,
  );
  if (list.length === 0) return;
  try {
    // arrayUnion can't carry a serverTimestamp inside its element, so stamp the
    // step time client-side (Date.now ISO) and bump the doc's updatedAt.
    const at = new Date().toISOString();
    const steps = list.map((label) => ({ label, at }));
    await runRef(repoId, runId).update({
      steps: FieldValue.arrayUnion(...steps),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    logger.warn('agentTrace.appendStep failed (best-effort)', {
      repoId,
      runId,
      err: String(err),
    });
  }
}

/**
 * Close a run: set its final `status` ('done' | 'error') + `updatedAt`. No-op on
 * a missing/invalid runId. BEST-EFFORT — NEVER throws.
 */
export async function finishRun(
  repoId: string,
  runId: string | undefined,
  status: 'done' | 'error',
): Promise<void> {
  if (!isValidRunId(runId)) return;
  try {
    await runRef(repoId, runId).update({
      status,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    logger.warn('agentTrace.finishRun failed (best-effort)', {
      repoId,
      runId,
      err: String(err),
    });
  }
}
