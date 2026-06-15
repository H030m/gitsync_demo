import { onCall, HttpsError } from 'firebase-functions/v2/https';

import { REGION } from '../admin';
import { openaiKey } from '../config';
import { askRepoFlow, type AskRepoTurn } from '../flows/askRepo';

// runId is a client-generated agent-trace doc id; validate its shape so it can
// never inject a path (the flow writes `agentRuns/{runId}`). Mirrors the guard
// in tools/agentTrace.ts.
const RUNID_RE = /^[A-Za-z0-9_-]{1,200}$/;

export const askRepo = onCall(
  { region: REGION, secrets: [openaiKey], timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const { repoId, question, history, runId } = request.data as {
      repoId?: string;
      question?: string;
      history?: AskRepoTurn[];
      runId?: string;
    };
    if (!repoId || !question || !question.trim()) {
      throw new HttpsError(
        'invalid-argument',
        'repoId and a non-empty question are required',
      );
    }
    if (runId !== undefined && !RUNID_RE.test(runId)) {
      throw new HttpsError('invalid-argument', 'runId has an invalid format');
    }
    return askRepoFlow({
      repoId,
      question: question.trim(),
      history: Array.isArray(history) ? history : [],
      runId,
    });
  },
);
