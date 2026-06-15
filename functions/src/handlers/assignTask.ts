import { onCall, HttpsError } from 'firebase-functions/v2/https';

import { REGION } from '../admin';
import { openaiKey } from '../config';
import { assignTaskFlow } from '../flows/assignTask';

export const assignTask = onCall(
  { region: REGION, secrets: [openaiKey], timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const { repoId, taskId } = request.data as {
      repoId?: string;
      taskId?: string;
    };
    if (!repoId || !taskId) {
      throw new HttpsError(
        'invalid-argument',
        'repoId and taskId are required',
      );
    }
    return assignTaskFlow({ repoId, taskId });
  },
);
