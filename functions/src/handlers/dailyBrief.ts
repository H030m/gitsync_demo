import { onCall, HttpsError } from 'firebase-functions/v2/https';

import { REGION } from '../admin';
import { openaiKey } from '../config';
import { dailyBriefChatFlow, type BriefChatTurn } from '../flows/dailyBriefChat';

// dailyBrief — agentic "ask AI about today" chat for the Summary tab. Auth-gated
// like the other callables; runs the function-calling loop over the day's
// commits / tasks / Discord digest and returns the answer plus surfaced commits.
export const dailyBrief = onCall(
  { region: REGION, secrets: [openaiKey], timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const { repoId, date, endDate, question, history } = request.data as {
      repoId?: string;
      date?: string;
      endDate?: string;
      question?: string;
      history?: BriefChatTurn[];
    };
    if (!repoId || !date || !question) {
      throw new HttpsError(
        'invalid-argument',
        'repoId, date (YYYY-MM-DD) and question are required',
      );
    }
    if (endDate && endDate < date) {
      throw new HttpsError('invalid-argument', 'endDate must be >= date');
    }
    return dailyBriefChatFlow({ repoId, date, endDate, question, history });
  },
);
