import { onCall, HttpsError } from 'firebase-functions/v2/https';

import { REGION } from '../admin';
import { openaiKey } from '../config';
import { discordChatFlow, type ChatTurn } from '../flows/discordChat';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const discordChat = onCall(
  { region: REGION, secrets: [openaiKey], timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const { repoId, question, history, startDate, endDate, runId } =
      request.data as {
        repoId?: string;
        question?: string;
        history?: ChatTurn[];
        startDate?: string;
        endDate?: string;
        runId?: string;
      };
    if (!repoId || !question || !question.trim()) {
      throw new HttpsError(
        'invalid-argument',
        'repoId and a non-empty question are required',
      );
    }
    if (runId !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(runId)) {
      throw new HttpsError('invalid-argument', 'runId has an invalid format');
    }
    // Range is optional but must come as a complete, well-formed pair
    // (same contract as getCommitGraph). It time-scopes the AI's reads.
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
    if (startDate && startDate > endDate!) {
      throw new HttpsError('invalid-argument', 'startDate must be <= endDate');
    }
    return discordChatFlow({
      repoId,
      question: question.trim(),
      history: Array.isArray(history) ? history : [],
      startDate,
      endDate,
      runId,
    });
  },
);
