// Outbound FCM push notifications to a single user.
// Best-effort: a failed notification must never break the caller's main flow
// (the Firestore write that triggered us has already succeeded — Rule D).
import { logger } from 'firebase-functions/v2';
import { getMessaging } from 'firebase-admin/messaging';

import { db } from '../admin';
import { notifyLocaleFromPref, NotifyLocale } from './i18n';

/**
 * Send an FCM push to `userId` by reading their `fcmToken` from
 * `apps/gitsync/users/{userId}`. No token → silently skipped. Any send error is
 * logged and swallowed (best-effort). Returns `true` only when a push was sent.
 *
 * `notification` may be a fixed `{ title, body }` or a builder
 * `(locale) => { title, body }`. When a builder is given it receives the
 * recipient's stored UI language (`apps/gitsync/users/{uid}.locale`, defaulting
 * to Traditional Chinese) so push copy is localized per recipient — bodies that
 * are real data (e.g. a task title) stay verbatim. See `tools/i18n.ts`.
 *
 * `data` is an optional FCM data payload (values must be strings) the client
 * reads on tap to deep-link — e.g. `{ type, repoId, taskId }` routes straight to
 * the task detail page (see `lib/services/push_messaging.dart`).
 */
export async function notifyAssignee(
  userId: string,
  notification:
    | { title: string; body: string }
    | ((locale: NotifyLocale) => { title: string; body: string }),
  data?: Record<string, string>,
): Promise<boolean> {
  try {
    const snap = await db.doc(`apps/gitsync/users/${userId}`).get();
    const userData = snap.data() ?? {};
    const token = userData.fcmToken as string | undefined;
    if (!token) {
      logger.info('notifyAssignee: no fcmToken, skipping', { userId });
      return false;
    }
    const locale = notifyLocaleFromPref(userData.locale);
    const resolved =
      typeof notification === 'function' ? notification(locale) : notification;
    await getMessaging().send({
      token,
      notification: resolved,
      ...(data ? { data } : {}),
    });
    return true;
  } catch (e) {
    logger.warn('notifyAssignee: send failed', { userId, error: String(e) });
    return false;
  }
}
