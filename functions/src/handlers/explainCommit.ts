import { onCall, HttpsError } from 'firebase-functions/v2/https';

import { db, REGION } from '../admin';
import { openaiKey } from '../config';
import { explainCommitFlow } from '../flows/explainCommit';

// explainCommit — the commit tree map's "tap a commit, AI explains the work"
// callable. Cached on the commit doc; pass force=true to regenerate.
//
// 06-05 D2: branch-graph commits may have no Firestore doc (predate all-branch
// ingest). We resolve the caller's GitHub token + repo owner/repo (same source
// as getCommitGraph) and hand them to the flow as an optional fallback so it can
// summarize straight from the GitHub API instead of 404ing. These are additive
// and best-effort — when any is absent the flow keeps its doc-only behavior.
export const explainCommit = onCall(
  { region: REGION, secrets: [openaiKey], timeoutSeconds: 60 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const uid = request.auth.uid;
    const { repoId, sha, force, language, runId } = request.data as {
      repoId?: string;
      sha?: string;
      force?: boolean;
      language?: string;
      runId?: string;
    };
    if (!repoId || !sha) {
      throw new HttpsError('invalid-argument', 'repoId and sha are required');
    }
    // W6: optional language (a human-readable English language NAME the client
    // derives from the app locale) forces the recomputed summary into that
    // language; absent → unchanged behavior (the first tap omits it).
    if (language !== undefined && typeof language !== 'string') {
      throw new HttpsError('invalid-argument', 'language must be a string');
    }
    // Optional client-generated trace doc id; streams the agentic loop's live
    // progress. Absent → the trace is a no-op.
    if (runId !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(runId)) {
      throw new HttpsError('invalid-argument', 'runId has an invalid format');
    }

    // Best-effort fallback inputs: resolve owner/repo from the repo doc's `name`
    // ("owner/repo") and the caller's stored GitHub OAuth token. Any missing
    // piece simply disables the fallback (flow stays doc-only).
    let owner: string | undefined;
    let repo: string | undefined;
    let accessToken: string | undefined;
    const repoSnap = await db.doc(`apps/gitsync/repos/${repoId}`).get();
    const slug = (repoSnap.data()?.name as string | undefined) ?? '';
    const slash = slug.indexOf('/');
    if (slash > 0) {
      owner = slug.slice(0, slash);
      repo = slug.slice(slash + 1);
    }
    const userSnap = await db.doc(`apps/gitsync/users/${uid}`).get();
    accessToken = userSnap.data()?.githubAccessToken as string | undefined;

    return explainCommitFlow({
      repoId,
      sha,
      force: force === true,
      language,
      runId,
      owner,
      repo,
      accessToken,
    });
  },
);
