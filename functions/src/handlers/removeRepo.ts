// removeRepo (callable) — the symmetric inverse of addRepo. Verifies the caller
// is the repo owner, best-effort deletes the GitHub webhook, then removes the
// member pointers + the repo doc and all its subcollections from Firestore.
//
// See ARCHITECTURE.md §6.2 (addRepo) for the forward flow this reverses.
import { logger } from 'firebase-functions/v2';
import { onCall, HttpsError } from 'firebase-functions/v2/https';

import { db, REGION } from '../admin';
import { deleteWebhook } from '../services/githubClient';
import { parseGithubUrl } from './addRepo';

export const removeRepo = onCall(
  { region: REGION },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('failed-precondition', 'Please log in first.');
    }
    const uid = request.auth.uid;

    const { repoId } = request.data as { repoId?: string };
    if (!repoId || typeof repoId !== 'string') {
      throw new HttpsError('invalid-argument', 'repoId is required');
    }

    // 1. Load the repo doc; missing → not-found.
    const repoRef = db.doc(`apps/gitsync/repos/${repoId}`);
    const repoSnap = await repoRef.get();
    if (!repoSnap.exists) {
      throw new HttpsError('not-found', `Repository ${repoId} not found.`);
    }
    const repo = repoSnap.data() ?? {};

    // 2. Owner check: members/{uid}.role === 'owner' OR repo doc createdBy === uid.
    const memberSnap = await db
      .doc(`apps/gitsync/repos/${repoId}/members/${uid}`)
      .get();
    const isOwner =
      memberSnap.data()?.role === 'owner' || repo.createdBy === uid;
    if (!isOwner) {
      throw new HttpsError(
        'permission-denied',
        'Only the repo owner can remove it.',
      );
    }

    // 3. Best-effort webhook delete. Any failure (no token / expired / hook
    //    already gone / no permission) is logged and must not block cleanup.
    const webhookId = repo.webhookId as number | null | undefined;
    if (typeof webhookId === 'number') {
      try {
        const parsed =
          parseGithubUrl(String(repo.name ?? '')) ??
          parseGithubUrl(String(repo.url ?? ''));
        if (!parsed) {
          throw new Error('could not derive owner/repo from repo doc');
        }
        const userSnap = await db.doc(`apps/gitsync/users/${uid}`).get();
        const token = userSnap.data()?.githubAccessToken as string | undefined;
        if (!token) {
          throw new Error('no github access token for caller');
        }
        await deleteWebhook(parsed.owner, parsed.repo, token, webhookId);
      } catch (err) {
        logger.warn('deleteWebhook failed (best-effort), continuing', {
          repoId,
          status: (err as { status?: number }).status,
        });
      }
    }

    // 4. Firestore cleanup. First remove each member's pointer doc, then
    //    recursively delete the repo doc + all subcollections.
    const memberIds = Array.isArray(repo.memberIds)
      ? (repo.memberIds as string[])
      : [];
    const uids = memberIds.length > 0 ? memberIds : [uid];
    await Promise.all(
      uids.map((memberUid) =>
        db.doc(`apps/gitsync/users/${memberUid}/repos/${repoId}`).delete(),
      ),
    );
    await db.recursiveDelete(repoRef);

    return {};
  },
);
