import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getMessaging } from 'firebase-admin/messaging';

import { REGION } from '../admin';

export const subscribeToTopic = onCall(
  { region: REGION },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const { token, topic } = request.data as { token?: string; topic?: string };
    if (!token || !topic) {
      throw new HttpsError(
        'invalid-argument',
        'token and topic are required',
      );
    }
    await getMessaging().subscribeToTopic(token, topic);
    return { ok: true };
  },
);
