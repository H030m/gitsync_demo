import { onCall, HttpsError } from 'firebase-functions/v2/https';

import { REGION } from '../admin';
import { openaiKey } from '../config';
import { summarizeAuthorWorkFlow } from '../flows/summarizeAuthorWork';

// summarizeAuthorWork — the 進度表 "what did this person work on?" callable.
// Given a canonical author (a GitHub login and/or a set of git names), generates
// (and caches) a short markdown AI work summary from that author's commits.
// Pass force=true to regenerate. Cache lives under the repo's authorSummaries
// subcollection (see the flow), keyed on the author's current commit count.
export const summarizeAuthorWork = onCall(
  { region: REGION, secrets: [openaiKey], timeoutSeconds: 60 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const { repoId, login, names, force } = request.data as {
      repoId?: string;
      login?: string;
      names?: string[];
      force?: boolean;
    };
    if (!repoId) {
      throw new HttpsError('invalid-argument', 'repoId is required');
    }
    const safeNames = Array.isArray(names)
      ? names.filter((n): n is string => typeof n === 'string')
      : [];
    const hasLogin = typeof login === 'string' && login.trim().length > 0;
    const hasNames = safeNames.some((n) => n.trim().length > 0);
    if (!hasLogin && !hasNames) {
      throw new HttpsError(
        'invalid-argument',
        'at least one of login or names is required',
      );
    }

    return summarizeAuthorWorkFlow({
      repoId,
      login: hasLogin ? login : undefined,
      names: safeNames,
      force: force === true,
    });
  },
);
