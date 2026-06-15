// onPullRequestOpened — when a pullRequests doc enters state `open` and has
// not yet been triaged, run the triage flow (summary + reviewers + risk tags),
// persist the result on the doc, and post a Discord notification.
//
// Why onDocumentWritten (not onDocumentCreated): the doc is `set({merge:true})`
// by `handlePR` so a draft→ready re-fire may UPDATE a pre-existing doc, not
// create one. We act on any transition INTO open that hasn't been triaged yet.
//
// Idempotency: two guards stack — `markIdempotent(event.id)` rejects re-fires
// of the same Firestore trigger, and the `triagedAt` check on the after-data
// rejects a logically duplicate triage attempt that arrived through a different
// event path (e.g. opened immediately followed by ready_for_review on a draft
// in a tight loop). The persist step writes `triagedAt` LAST so a crash
// mid-flow leaves the doc retriable.
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';

import { db, REGION } from '../admin';
import { openaiKey } from '../config';
import { triagePr, type RecommendedReviewer } from '../flows/triagePr';
import { markIdempotent } from '../tools/idempotency';
import { notifyDiscord } from '../tools/discordNotify';

/**
 * Parses `repos/{repoId}.name` (canonical "owner/repo") into its parts.
 * Returns null when the shape is unexpected. Repo names can contain `_`, so
 * we don't split `repoId` itself.
 */
function ownerRepoFromName(
  name: unknown,
): { owner: string; repo: string } | null {
  if (typeof name !== 'string') return null;
  const idx = name.indexOf('/');
  if (idx <= 0 || idx === name.length - 1) return null;
  return { owner: name.slice(0, idx), repo: name.slice(idx + 1) };
}

/**
 * Discord-flavored render of the triage payload. Mentions use
 * `<@discordUserId>` when present, otherwise fall back to `@githubLogin`
 * (no ping but still attributable). Kept inline (no template helper) — one
 * caller, three short branches.
 */
function formatDiscordMessage(
  prNumber: number,
  title: string,
  htmlUrl: string,
  summary: string,
  reviewers: RecommendedReviewer[],
  riskTags: string[],
): string {
  const lines: string[] = [];
  const linkedTitle = htmlUrl
    ? `[#${prNumber} ${title}](<${htmlUrl}>)`
    : `#${prNumber} ${title}`;
  lines.push(`**New PR — ${linkedTitle}**`);
  if (summary) lines.push(summary);
  if (reviewers.length > 0) {
    const mentions = reviewers
      .map((r) =>
        r.discordUserId
          ? `<@${r.discordUserId}>`
          : r.githubLogin
            ? `@${r.githubLogin}`
            : null,
      )
      .filter((m): m is string => m !== null);
    if (mentions.length > 0) {
      lines.push(`Suggested reviewers: ${mentions.join(' ')}`);
    }
  }
  if (riskTags.length > 0) {
    lines.push(`Risk: ${riskTags.map((t) => `\`${t}\``).join(' ')}`);
  }
  return lines.join('\n');
}

export const onPullRequestOpened = onDocumentWritten(
  {
    document: 'apps/gitsync/repos/{repoId}/pullRequests/{prNumber}',
    region: REGION,
    secrets: [openaiKey],
  },
  async (event) => {
    const fresh = await markIdempotent(event.id);
    if (!fresh) return;

    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after) return; // deletion — nothing to do

    // Self-filter: we only want PRs that are currently open AND haven't been
    // triaged yet. The doc is shared with onPRMerged (state=merged), so this
    // guard is what keeps the two triggers from stepping on each other.
    if (after.state !== 'open') return;
    if (after.triagedAt) return;
    // Skip if we already saw the same open doc (e.g. the previous fire of
    // this very trigger wrote triagedAt but Firestore double-delivered).
    if (before?.state === 'open' && before?.triagedAt) return;

    const { repoId, prNumber: prNumberStr } = event.params as {
      repoId: string;
      prNumber: string;
    };
    const prNumber = Number(prNumberStr);
    if (!Number.isFinite(prNumber)) {
      logger.warn('onPullRequestOpened: non-numeric prNumber, skipping', {
        repoId,
        prNumber: prNumberStr,
      });
      return;
    }

    const repoSnap = await db.doc(`apps/gitsync/repos/${repoId}`).get();
    const repoData = repoSnap.data();
    if (!repoData) {
      logger.warn('onPullRequestOpened: repo doc missing, skipping', { repoId });
      return;
    }

    const parsed = ownerRepoFromName(repoData.name);
    if (!parsed) {
      logger.warn('onPullRequestOpened: cannot resolve owner/repo, skipping', {
        repoId,
      });
      return;
    }

    // Use the repo creator's token — same pattern as `onTaskCreated`. If they
    // ever rotate / lose their token we'd need a fallback (any member with a
    // token); not implemented here, just logged.
    const createdBy = repoData.createdBy as string | undefined;
    if (!createdBy) {
      logger.warn('onPullRequestOpened: repo has no createdBy, skipping', {
        repoId,
      });
      return;
    }
    const userSnap = await db.doc(`apps/gitsync/users/${createdBy}`).get();
    const accessToken = userSnap.data()?.githubAccessToken as
      | string
      | undefined;
    if (!accessToken) {
      logger.warn(
        'onPullRequestOpened: no GitHub token for repo creator, skipping',
        { repoId, createdBy },
      );
      return;
    }

    const title = (after.title as string | undefined) ?? '';
    const body = (after.body as string | undefined) ?? '';
    const prAuthorLogin = (after.authorLogin as string | undefined) ?? '';
    const htmlUrl = (after.htmlUrl as string | undefined) ?? '';

    const result = await triagePr({
      repoId,
      prNumber,
      prAuthorLogin,
      title,
      body,
      owner: parsed.owner,
      repo: parsed.repo,
      accessToken,
    });

    // Persist FIRST (durable record) — a Discord outage must not lose it.
    // triagedAt is the idempotency marker; written last so a partial write
    // doesn't latch us out of retrying.
    await db
      .doc(`apps/gitsync/repos/${repoId}/pullRequests/${prNumber}`)
      .set(
        {
          aiSummary: result.summary,
          recommendedReviewers: result.recommendedReviewers.map((r) => r.userId),
          recommendedReviewerDetails: result.recommendedReviewers,
          // Per-pick scoring breakdown (workload-aware A+D, 06-13). Pure
          // observability for retuning LOAD_LAMBDA / floor — not consumed by
          // the UI or any downstream flow.
          recommendedReviewerScores: result.reviewerScores,
          riskTags: result.riskTags,
          triagedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

    // Best-effort Discord post (notifyDiscord already swallows its own errors).
    const webhookUrl = repoData.discordWebhookUrl as string | undefined;
    if (webhookUrl) {
      const content = formatDiscordMessage(
        prNumber,
        title,
        htmlUrl,
        result.summary,
        result.recommendedReviewers,
        result.riskTags,
      );
      await notifyDiscord(webhookUrl, content);
    }

    logger.info('onPullRequestOpened: triaged', {
      repoId,
      prNumber,
      reviewers: result.recommendedReviewers.length,
      riskTags: result.riskTags,
      posted: Boolean(webhookUrl),
    });
  },
);
