# PR Triage Agent — webhook → diff summary + 2 reviewer recommendation

## Goal

When a GitHub PR is opened on a tracked repo, the existing webhook handler
fires a new triage agent that **(a) writes a short LLM summary of the diff**
and **(b) recommends exactly 2 reviewers** based on who has historically
touched the changed files. Output is surfaced where the team will see it
(channel TBD — see Open Questions). Closes the visible gap that
`tools/discordNotify.ts` exists but is never called from any flow.

## What I already know (from repo inspection, 2026-06-08)

* **Webhook receiver**: `functions/src/handlers/githubWebhook.ts` — currently
  handles `push` + `pull_request` (`closed && merged` only) + `issues`. HMAC
  verified against `repos/{repoId}.webhookSecret`. Idempotency via
  `x-github-delivery`. Writes `pullRequests/{number}` doc on merge.
* **GitHub client**: `functions/src/services/githubClient.ts` — has
  `getRecentCommits()`, `getCommit()` (returns `.files`), `fetchCommitGraph()`.
  No existing helper for "commits touching path X" — needs new method
  (`listCommitsForPath(path, perPage)` → `GET /repos/{o}/{r}/commits?path=...`).
* **Discord posting**: `tools/discordNotify.ts:notifyDiscord({repoId, content})`
  — POSTs to `repos/{repoId}.discordWebhookUrl`. Best-effort, errors swallowed.
  **Currently called from nowhere.**
* **LLM stack**: OpenAI via `getOpenAI()` + `MODELS` from
  `functions/src/config.ts`, secret `openaiKey`. Used by `flows/discordChat`,
  `flows/breakdownTask`, `flows/dailyBriefChat`. New flow will follow same
  pattern.
* **Members / users**:
  * `apps/gitsync/users/{userId}` — `githubLogin`, `discordUserId`, `fcmToken`
  * `apps/gitsync/repos/{repoId}/members/{userId}` — `activeIssueCount`, etc.
* **Three-way ID map**: userId ↔ githubLogin ↔ discordUserId (see
  `tools/assignTools.ts:14`). Mapping githubLogin → userId requires Firestore
  query on `users` where `githubLogin == X`.

## Assumptions (temporary — flag if wrong)

* MVP triggers on `pull_request.opened` only. Drafts excluded. Reopened /
  ready_for_review excluded for MVP (see Open Questions).
* Self-exclude: PR author is never recommended as their own reviewer.
* Exactly 2 reviewers — if fewer than 2 candidates found, return whoever we
  have (1 or 0); no fallback to random members for MVP.
* Recommendation uses **file-history** (who has committed to these paths),
  not semantic commit-message similarity. The existing vector
  `searchMemberCommits()` answers a different question.
* Summary is short — target 3–5 lines (~60 tokens), focus on *intent* not
  *file list* (GitHub already shows the file list).
* No GitHub PR comment write-back for MVP (would need a PAT with `pulls:write`
  per-repo; defer).

## Decisions (locked 2026-06-08)

* **Output channels**: Discord webhook + Firestore write to `pullRequests/{number}`.
  GitHub PR comment is deferred (needs `pulls:write` scope plumbing).
* **Risk tags in MVP**: yes — deterministic, zero LLM cost. Tag set:
  `large-diff` (>300 LOC additions+deletions), `touches-functions`
  (any path under `functions/`), `touches-rules` (`firestore.rules` or
  `firestore.indexes.json`), `touches-schema` (any path matching
  `**/migrations/**` or `**/schema/**`).
* **Trigger events**: `pull_request.opened` and `pull_request.ready_for_review`
  (draft → ready). `reopened` and `synchronize` excluded — avoid re-spamming
  on every push.

## Requirements (evolving)

* Extend `githubWebhook.ts` to handle `pull_request.opened` (and possibly
  `ready_for_review`) in addition to the existing closed+merged branch.
* New flow `functions/src/flows/triagePr.ts`:
  * Input: `{repoId, prNumber, prTitle, prBody, prAuthorLogin, headSha, baseSha}`
  * Fetches changed files via `compareCommits(base, head)` or
    `pulls.listFiles` (new `githubClient` method).
  * For each changed path, calls a new `listCommitsForPath(path, perPage=10)`
    GitHub API helper; aggregates committers by login, weighted by recency
    (recent commits count more).
  * Maps top githubLogins → userIds via Firestore `users` query,
    excludes the PR author, picks top 2.
  * Runs LLM summarization (OpenAI, model from `MODELS`) on title + body +
    a truncated diff (file list + first ~200 LOC of patch).
  * Computes deterministic risk tags.
  * Persists the triage result to `pullRequests/{number}` (new fields:
    `aiSummary`, `recommendedReviewers: [userId]`, `riskTags: [string]`,
    `triagedAt`).
  * Calls `notifyDiscord(repoId, content)` with a formatted message that
    mentions the recommended reviewers' `discordUserId`s.
* Idempotency: if `pullRequests/{number}.triagedAt` is set, skip.

## Acceptance Criteria (evolving)

* [ ] Opening a real PR on a webhook-connected repo produces, within ~30s:
  - [ ] A Discord post in the configured channel containing summary + 2 @
        mentions + risk tags.
  - [ ] A `pullRequests/{number}` doc with `aiSummary`,
        `recommendedReviewers`, `riskTags`, `triagedAt` populated.
* [ ] Re-delivering the same webhook (same `x-github-delivery`) is a no-op
      (existing idempotency path is reused).
* [ ] PR author is never in `recommendedReviewers`.
* [ ] If fewer than 2 file-history candidates exist (e.g. brand-new repo),
      returns 0 or 1, never throws.
* [ ] Unit test: `triagePr` flow with mocked GitHub + OpenAI returns expected
      `{summary, reviewers, riskTags}` shape.
* [ ] Integration test (mocked Firestore + nock'd GitHub): webhook with
      `action=opened` payload writes the expected doc fields and triggers
      the Discord webhook (mock).

## Definition of Done

* Unit + integration tests pass.
* `flutter analyze` / `npm run lint` / `npm run typecheck` green for
  `functions/`.
* `tools/discordNotify.ts` is now called from at least one flow (this one).
* `pullRequests/{number}` schema documented inline near the write call.
* Manual smoke test on a throwaway PR in a test repo.

## Out of Scope (explicit)

* Writing the triage summary as a GitHub PR comment (needs OAuth scope work).
* In-app push notification (FCM) for the recommended reviewers — that's the
  separate `06-03-wire-fcm-notifications` task. Once it lands, triage can
  re-use it.
* Auto-requesting reviewers via GitHub's reviewer API (needs `pulls:write`).
* Re-triaging on PR sync / new commits.
* "Risk tag" → severity label color mapping in the kanban card UI.
* Backfill for already-open PRs.

## Technical Notes

* `notifyDiscord()` swallows errors — that's fine for MVP, but the triage
  flow itself should be wrapped in try/catch so a Discord outage doesn't lose
  the Firestore write.
* GitHub rate limits: file-history loop is the risk. Cap at 10 changed files
  (sorted by `additions+deletions` desc) for MVP; document the cap.
* OpenAI cost: ~1 call per PR, prompt ≤ ~2K tokens. Cheap.
* Existing `functions/src/__tests__/` has patterns for nock'ing GitHub +
  mocking `getOpenAI()`; follow those.

## Research References

* (none — all decisions derivable from existing repo patterns + GitHub API
  docs; no external research needed.)
