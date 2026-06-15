// importCollaborators — pull a repo's GitHub collaborators and add the ones who
// already have a GitSync account (signed in at least once → have a Firebase uid)
// as repo members, so they become assignable. Collaborators who haven't signed
// into the app yet can't be members (members are keyed by Firebase uid and need
// an fcmToken to be notified) — they're returned as `pending` for the UI to show.
//
// Non-AI mutation, so the logic lives in the handler (mirrors addRepo). `members`
// is client-write-blocked, which is exactly why this must be a Cloud Function.
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';

import { db, REGION } from '../admin';
import { listCollaborators } from '../services/githubClient';

/** Splits the repo doc `name` ("owner/repo") into owner/repo (names may contain `_`). */
function ownerRepoFromName(name: unknown): { owner: string; repo: string } | null {
  if (typeof name !== 'string') return null;
  const idx = name.indexOf('/');
  if (idx <= 0 || idx === name.length - 1) return null;
  return { owner: name.slice(0, idx), repo: name.slice(idx + 1) };
}

export const importCollaborators = onCall(
  { region: REGION, timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const { repoId } = request.data as { repoId?: string };
    if (!repoId) {
      throw new HttpsError('invalid-argument', 'repoId is required');
    }

    const repoRef = db.doc(`apps/gitsync/repos/${repoId}`);
    const repoSnap = await repoRef.get();
    const parsed = ownerRepoFromName(repoSnap.data()?.name);
    if (!parsed) {
      throw new HttpsError('not-found', 'repo not found');
    }

    // Use the caller's GitHub token to read collaborators.
    const callerSnap = await db.doc(`apps/gitsync/users/${request.auth.uid}`).get();
    const token = callerSnap.data()?.githubAccessToken as string | undefined;
    if (!token) {
      throw new HttpsError(
        'failed-precondition',
        'No GitHub token on your account — sign in with GitHub again.',
      );
    }

    let collaborators;
    try {
      collaborators = await listCollaborators(parsed.owner, parsed.repo, token);
    } catch (err) {
      logger.warn('importCollaborators: GitHub list failed', {
        repoId,
        err: String(err),
      });
      throw new HttpsError('internal', 'Could not read GitHub collaborators.');
    }

    const batch = db.batch();
    let added = 0;
    let alreadyMembers = 0;
    const pending: string[] = [];

    for (const c of collaborators) {
      // Map GitHub login → an existing app user (signed in before).
      const userQ = await db
        .collection('apps/gitsync/users')
        .where('githubLogin', '==', c.login)
        .limit(1)
        .get();
      if (userQ.empty) {
        pending.push(c.login); // no GitSync account yet → can't be a member
        continue;
      }
      const uid = userQ.docs[0].id;
      const memberRef = db.doc(`apps/gitsync/repos/${repoId}/members/${uid}`);
      const memberSnap = await memberRef.get();
      if (memberSnap.exists) {
        alreadyMembers++;
        continue;
      }
      // New member — seed workload counters; don't clobber an existing doc.
      batch.set(memberRef, {
        role: 'member',
        activeIssueCount: 0,
        completedTaskCount: 0,
        joinedAt: FieldValue.serverTimestamp(),
      });
      batch.update(repoRef, { memberIds: FieldValue.arrayUnion(uid) });
      added++;
    }

    if (added > 0) await batch.commit();

    logger.info('importCollaborators: done', {
      repoId,
      added,
      alreadyMembers,
      pending: pending.length,
    });
    return { added, alreadyMembers, pending };
  },
);
