# Fix getCommitGraph 502 — lighten the GraphQL query

## Goal

The branch graph intermittently fails with "GitHub API request failed".
Production logs show two failure shapes from the bulk GraphQL query:
1. `POST /graphql → 502 Bad Gateway` after ~10.6s — GitHub's ~10s internal
   processing limit; the query is too heavy: `refs(first:20)` ×
   `history(first:100)` × `associatedPullRequests(first:1)` ≈ 2000 nested PR
   lookups per call.
2. `TypeError: Cannot read properties of undefined (reading 'repository')`
   — partial/abnormal GraphQL responses are not guarded.

## Requirements

1. **Drop `associatedPullRequests` from the bulk query** (the dominant cost).
   PR numbers on merge nodes come from the message regex
   (`^Merge pull request #N`), which covers this team's standard merges.
   `assembleGraph` keeps accepting `associatedPrNumber` (null everywhere now)
   so the payload shape and Flutter parser stay unchanged.
2. **Guard the response**: treat `data?.repository` missing as an empty
   result or a clean thrown error — never a TypeError.
3. **Retry once** on transient failure (502/5xx/network) with a short delay
   before mapping to HttpsError('unavailable').
4. Tests updated: query no longer contains associatedPullRequests; merge
   without a regex-matching message now yields prNumber null; undefined
   response → clean error; retry path covered (first call rejects 502,
   second succeeds).

## Acceptance Criteria

* [ ] Bulk query contains no `associatedPullRequests`.
* [ ] Simulated 502-then-success succeeds via retry; double-502 maps to
  `unavailable`.
* [ ] Malformed/undefined GraphQL data never throws TypeError.
* [ ] functions typecheck/lint/tests green; flutter untouched.
* [ ] Deployed; refreshing the branch graph in the app succeeds repeatedly.

## Out of Scope

* Squash/rebase-merge PR-number resolution (lost with associatedPullRequests;
  team uses standard merge commits — message regex covers them). If needed
  later: a targeted second query for merge commits only.
* Pagination beyond the first 100 commits per branch.

## Technical Notes

* `functions/src/services/githubClient.ts` — COMMIT_GRAPH_QUERY, fetchCommitGraph.
* Retry can live in fetchCommitGraph (one retry, ~500ms) or the flow; prefer
  the service (keeps the flow simple).
* GraphQlCommitNode type: associatedPullRequests field removed; toGraphCommitRaw
  sets associatedPrNumber: null.
