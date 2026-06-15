// githubWebhook (onRequest) — receives GitHub push / PR / issue events.
//
// IMPORTANT: This handler ONLY normalizes raw payloads and writes Firestore
// docs. All business logic (linking commits to tasks, computing embeddings,
// calling OpenAI, marking tasks done) happens in the matching Firestore Trigger
// (`onCommitCreated`, `onPRMerged`, `onIssueWritten`). See MEMORY.md 2026-05-26
// "webhook only writes raw, trigger does AI" and ARCHITECTURE.md §6.3.
import { createHmac, timingSafeEqual } from 'node:crypto';

import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { db, REGION } from '../admin';
import { markIdempotent } from '../tools/idempotency';

/**
 * Verifies the GitHub HMAC-SHA256 signature of the raw body against the repo's
 * stored `webhookSecret`. Uses `timingSafeEqual` (length-guarded) to avoid
 * timing leaks. Returns false on any mismatch / missing input.
 */
function verifySignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!rawBody || !signatureHeader) return false;
  const expected =
    'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Writes a raw commit doc per push commit. No `#N` parsing, no embeddings, no
 * linkedTaskIds — `onCommitCreated` (Layer 2) does all of that.
 *
 * All-branch ingest (PRD 06-05 D1): we persist commits pushed to EVERY branch,
 * not just the default. Feature-branch work must reach Firestore so the Commits
 * list shows it in realtime and explainCommit can resolve branch-graph commits.
 * The push `ref` (`refs/heads/<branch>`) is stored as `branch`.
 *
 * First-seen wins: when a feature branch later merges to main, GitHub re-pushes
 * the SAME shas under the default-branch ref. We must NOT overwrite the existing
 * doc — a plain `batch.set` would clobber the enriched fields that
 * `onCommitCreated` wrote (aiSummary, embedding, linkedTaskIds, workSummary) and
 * reset createdAt. So we use per-commit `create()` (fails on an existing doc)
 * and ignore ALREADY_EXISTS, preserving the original feature-branch attribution.
 *
 * Note: GitHub's push payload caps `commits[]` at 20 — larger pushes are covered
 * by the backfill script / PR-merge flows, not here.
 */
async function handlePush(repoId: string, body: Record<string, unknown>): Promise<void> {
  const ref = body.ref as string | undefined;
  const branch = ref ? ref.replace('refs/heads/', '') : '';

  const repository = body.repository as { default_branch?: string } | undefined;
  const defaultBranch = repository?.default_branch;
  const isDefaultBranch = !!defaultBranch && branch === defaultBranch;

  const commits = (body.commits as Array<Record<string, unknown>> | undefined) ?? [];
  if (commits.length === 0) return;

  const writes = commits.map(async (c) => {
    const sha = c.id as string | undefined;
    if (!sha) return;
    const author = (c.author as Record<string, unknown> | undefined) ?? {};
    const added = (c.added as string[] | undefined) ?? [];
    const removed = (c.removed as string[] | undefined) ?? [];
    const modified = (c.modified as string[] | undefined) ?? [];
    // `committedAt` MUST be a Firestore Timestamp (not the payload's ISO
    // string): the Flutter Commit model and every range query (Flutter
    // streamRange, dailyIntel listRangeCommits) compare against Timestamps —
    // string-typed values silently fall out of those queries. Fall back to
    // the server time so the field always exists with a uniform type.
    const parsedTs = c.timestamp ? new Date(c.timestamp as string) : null;
    const committedAt =
      parsedTs && !Number.isNaN(parsedTs.getTime())
        ? Timestamp.fromDate(parsedTs)
        : FieldValue.serverTimestamp();
    const docRef = db.doc(`apps/gitsync/repos/${repoId}/commits/${sha}`);
    // `create()` (not `set`) for first-seen-wins: it rejects when the doc
    // already exists, so a merge re-push can't clobber enriched fields.
    await docRef.create({
      repoId,
      sha,
      message: (c.message as string | undefined) ?? '',
      author: {
        // Canonical schema is `author.{login,name,email}` (ARCHITECTURE §2.1).
        // The GitHub push payload carries the GitHub handle as `author.username`
        // — store it as `login` so searchMemberCommits' `author.login` prefilter
        // (assignTaskFlow vector search) actually matches.
        login: (author.username as string | undefined) ?? '',
        name: (author.name as string | undefined) ?? '',
        email: (author.email as string | undefined) ?? '',
      },
      url: (c.url as string | undefined) ?? '',
      // Canonical schema: `filesChanged` is the list of touched file paths
      // (consumed by the Flutter commit sheet's file chips and by
      // explainCommit's prompt context), not a count.
      filesChanged: [...added, ...removed, ...modified],
      added,
      removed,
      modified,
      committedAt,
      // First-seen branch attribution (06-05 D1): the ref this sha first
      // arrived on. Not overwritten by a later merge re-push (create-only).
      branch,
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  const results = await Promise.allSettled(writes);
  for (const r of results) {
    if (r.status === 'rejected') {
      // ALREADY_EXISTS (gRPC code 6) is expected for first-seen-wins — the doc
      // was already ingested on its original branch; skip silently. Log others.
      const err = r.reason as { code?: number; message?: string } | undefined;
      if (err?.code === 6) continue;
      logger.error('handlePush: commit create failed', {
        repoId,
        branch,
        err: String(r.reason),
      });
    }
  }

  // Auto-complete signal (06-14): only commits pushed to the DEFAULT branch are
  // eligible to auto-mark a linked task done. A commit first seen on a feature
  // branch already exists by the time it merges to main, so the `.create()`
  // above is skipped (ALREADY_EXISTS) and no onDocumentCreated re-fires. A
  // `set(merge)` of `onDefaultBranch: true` fires a WRITE even on a pre-existing
  // doc, which the dedicated `onCommitCompletesTask` (onDocumentWritten) trigger
  // guards on (transition false→true). Non-default branches leave the flag absent.
  if (isDefaultBranch) {
    const marks = commits.map(async (c) => {
      const sha = c.id as string | undefined;
      if (!sha) return;
      const docRef = db.doc(`apps/gitsync/repos/${repoId}/commits/${sha}`);
      await docRef.set({ onDefaultBranch: true }, { merge: true });
    });
    const markResults = await Promise.allSettled(marks);
    for (const r of markResults) {
      if (r.status === 'rejected') {
        logger.error('handlePush: onDefaultBranch mark failed', {
          repoId,
          branch,
          err: String(r.reason),
        });
      }
    }
  }
}

/**
 * Writes a raw pullRequests doc. Two paths today:
 *   * action=closed && merged=true → state=`merged`. `onPRMerged` parses
 *     closing keywords (`closes/fixes/resolves #N`) and marks tasks done.
 *   * action=opened OR action=ready_for_review → state=`open`.
 *     `onPullRequestOpened` runs the triage flow (summary + reviewers + risk
 *     tags). Drafts (PRs with `draft===true`) are skipped — they re-fire as
 *     `ready_for_review` when the author marks them ready.
 *
 * `reopened` and `synchronize` are deliberately ignored to avoid re-triaging
 * on every push. No task status changes here either way.
 */
async function handlePR(repoId: string, body: Record<string, unknown>): Promise<void> {
  const action = body.action as string | undefined;
  const pr = body.pull_request as Record<string, unknown> | undefined;
  if (!pr) return;

  const number = pr.number as number | undefined;
  if (number === undefined) return;

  const head = (pr.head as Record<string, unknown> | undefined) ?? {};
  const base = (pr.base as Record<string, unknown> | undefined) ?? {};
  const user = (pr.user as Record<string, unknown> | undefined) ?? {};

  if (action === 'closed' && pr.merged === true) {
    await db.doc(`apps/gitsync/repos/${repoId}/pullRequests/${number}`).set({
      repoId,
      number,
      title: (pr.title as string | undefined) ?? '',
      body: (pr.body as string | undefined) ?? '',
      state: 'merged',
      // GitHub's pull_request webhook payload does not include the commit SHA
      // list; Layer 2 (onPRMerged) can fetch them via the API if needed.
      commitShas: [],
      headBranch: (head.ref as string | undefined) ?? '',
      baseBranch: (base.ref as string | undefined) ?? '',
      mergedAt: (pr.merged_at as string | undefined) ?? null,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return;
  }

  // PR newly visible to humans: real `opened` (non-draft) or draft→ready.
  const isOpenedEvent =
    (action === 'opened' && pr.draft !== true) ||
    action === 'ready_for_review';
  if (!isOpenedEvent) return;

  await db.doc(`apps/gitsync/repos/${repoId}/pullRequests/${number}`).set(
    {
      repoId,
      number,
      title: (pr.title as string | undefined) ?? '',
      body: (pr.body as string | undefined) ?? '',
      state: 'open',
      authorLogin: (user.login as string | undefined) ?? '',
      headBranch: (head.ref as string | undefined) ?? '',
      headSha: (head.sha as string | undefined) ?? '',
      baseBranch: (base.ref as string | undefined) ?? '',
      htmlUrl: (pr.html_url as string | undefined) ?? '',
      openedAt: (pr.created_at as string | undefined) ?? null,
      // `triagedAt` left unset on purpose — onPullRequestOpened guards on this
      // to keep itself idempotent across re-deliveries / re-fires.
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/**
 * Upserts a raw issues doc mirroring GitHub's issue state. `onIssueWritten`
 * (Layer 2) reverse-syncs this into task status. No task writes here.
 */
async function handleIssue(repoId: string, body: Record<string, unknown>): Promise<void> {
  const action = body.action as string | undefined;
  const issue = body.issue as Record<string, unknown> | undefined;
  if (!issue) return;
  const number = issue.number as number | undefined;
  if (number === undefined) return;

  await db.doc(`apps/gitsync/repos/${repoId}/issues/${number}`).set(
    {
      repoId,
      number,
      state: (issue.state as string | undefined) ?? 'open',
      title: (issue.title as string | undefined) ?? '',
      action: action ?? '',
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

export const githubWebhook = onRequest(
  { region: REGION, maxInstances: 10 },
  async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const repository = body.repository as
      | { name?: string; owner?: { login?: string } }
      | undefined;
    const owner = repository?.owner?.login;
    const repo = repository?.name;

    // 1. HMAC verify against repos/{repoId}.webhookSecret (raw body).
    if (!owner || !repo) {
      logger.warn('githubWebhook: missing repository owner/name in payload');
      res.status(401).send('invalid payload');
      return;
    }
    const repoId = `${owner}_${repo}`;

    const repoSnap = await db.doc(`apps/gitsync/repos/${repoId}`).get();
    const webhookSecret = repoSnap.data()?.webhookSecret as string | undefined;
    if (!repoSnap.exists || !webhookSecret) {
      logger.warn('githubWebhook: unknown repo or missing secret', { repoId });
      res.status(401).send('unknown repo');
      return;
    }

    const signature = req.header('x-hub-signature-256') ?? undefined;
    if (!verifySignature(req.rawBody, signature, webhookSecret)) {
      logger.warn('githubWebhook: signature verification failed', { repoId });
      res.status(401).send('invalid signature');
      return;
    }

    // 2. Idempotency via x-github-delivery.
    const deliveryId = req.header('x-github-delivery') ?? undefined;
    if (!deliveryId) {
      logger.warn('githubWebhook: missing x-github-delivery', { repoId });
      res.status(400).send('missing delivery id');
      return;
    }
    const fresh = await markIdempotent(deliveryId);
    if (!fresh) {
      logger.info('githubWebhook: duplicate delivery, skipping', { repoId, deliveryId });
      res.status(200).send({ ok: true, dup: true });
      return;
    }

    // 3. Dispatch by event type. Wrap so a thrown error still returns 200
    //    (avoid GitHub retry storms) but is logged at error level.
    const event = req.header('x-github-event') ?? undefined;
    try {
      switch (event) {
        case 'push':
          await handlePush(repoId, body);
          break;
        case 'pull_request':
          await handlePR(repoId, body);
          break;
        case 'issues':
          await handleIssue(repoId, body);
          break;
        default:
          logger.info('githubWebhook: ignoring event', { repoId, event });
      }
    } catch (err) {
      logger.error('githubWebhook: handler error (returning 200 to avoid retry storm)', {
        repoId,
        event,
        err: String(err),
      });
    }

    res.status(200).send({ ok: true });
  },
);
