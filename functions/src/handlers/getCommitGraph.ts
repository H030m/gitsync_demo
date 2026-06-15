// getCommitGraph (callable) — branch-topology data for the Commits tab's
// branch-graph view. Fetched on demand from the GitHub API (push webhook
// payloads carry no parent SHAs — PRD D1), short-TTL cached by the flow.
import { onCall, HttpsError } from 'firebase-functions/v2/https';

import { db, REGION } from '../admin';
import { getCommitGraphFlow } from '../flows/getCommitGraph';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const getCommitGraph = onCall(
  { region: REGION, timeoutSeconds: 60 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const uid = request.auth.uid;

    const { repoId, startDate, endDate, force } = request.data as {
      repoId?: string;
      startDate?: string;
      endDate?: string;
      force?: boolean;
    };
    if (!repoId) {
      throw new HttpsError('invalid-argument', 'repoId is required');
    }
    // Range is optional but must come as a complete, well-formed pair.
    if (Boolean(startDate) !== Boolean(endDate)) {
      throw new HttpsError(
        'invalid-argument',
        'startDate and endDate must be provided together',
      );
    }
    if (startDate && (!DATE_RE.test(startDate) || !DATE_RE.test(endDate!))) {
      throw new HttpsError(
        'invalid-argument',
        'startDate/endDate must be YYYY-MM-DD',
      );
    }

    // Resolve owner/repo from the repo doc's `name` ("owner/repo") — repoId
    // itself is `${owner}_${repo}`, which is ambiguous when names contain `_`.
    const repoSnap = await db.doc(`apps/gitsync/repos/${repoId}`).get();
    if (!repoSnap.exists) {
      throw new HttpsError('not-found', 'repo not found');
    }
    const slug = (repoSnap.data()?.name as string | undefined) ?? '';
    const slash = slug.indexOf('/');
    if (slash <= 0) {
      throw new HttpsError('failed-precondition', 'repo doc has no owner/repo slug');
    }
    const owner = slug.slice(0, slash);
    const repo = slug.slice(slash + 1);

    // Same token source as addRepo: the caller's stored GitHub OAuth token.
    const userSnap = await db.doc(`apps/gitsync/users/${uid}`).get();
    const accessToken = userSnap.data()?.githubAccessToken as
      | string
      | undefined;
    if (!accessToken) {
      throw new HttpsError(
        'failed-precondition',
        'No GitHub access token found. Please complete GitHub authorization first.',
      );
    }

    return getCommitGraphFlow({
      repoId,
      owner,
      repo,
      accessToken,
      startDate,
      endDate,
      force: force === true,
    });
  },
);
