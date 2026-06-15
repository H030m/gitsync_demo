import { onCall, HttpsError } from 'firebase-functions/v2/https';

import { REGION } from '../admin';
import { openaiKey } from '../config';
import { generateHandoffFlow } from '../flows/generateHandoff';

export const generateHandoff = onCall(
  { region: REGION, secrets: [openaiKey], timeoutSeconds: 300 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const { repoId, taskId, runId, language } = request.data as {
      repoId?: string;
      taskId?: string;
      runId?: string;
      language?: string;
    };
    if (!repoId || !taskId) {
      throw new HttpsError(
        'invalid-argument',
        'repoId and taskId are required',
      );
    }
    if (runId !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(runId)) {
      throw new HttpsError('invalid-argument', 'runId has an invalid format');
    }
    // W6: optional language is a human-readable English language NAME the client
    // derives from the app locale (e.g. "Traditional Chinese"). Passed through to
    // force the regenerated doc into that language; absent → unchanged behavior.
    if (language !== undefined && typeof language !== 'string') {
      throw new HttpsError('invalid-argument', 'language must be a string');
    }
    // Manual invocation (the "Regenerate handoff" button) always produces a
    // fresh doc; the auto trigger (onTaskUpdated) calls the flow with force=false
    // so it only fills in a missing handoff. `runId` (optional) streams the
    // live agent trace; absent → the trace is a no-op.
    return generateHandoffFlow({ repoId, taskId, force: true, runId, language });
  },
);
