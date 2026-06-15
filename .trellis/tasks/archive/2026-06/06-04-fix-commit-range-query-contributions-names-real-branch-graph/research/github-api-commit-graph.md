# Research: GitHub API for `getCommitGraph` (commit-graph over a date range)

- **Query**: Best way for a Firebase Cloud Function (Node, `@octokit/rest` already a dep, wrapper `functions/src/services/githubClient.ts`) to assemble git commit-graph data (commits + parents, branch membership, fork/merge structure) for a repo over a date range. Planned callable `getCommitGraph(repoId, startDate?, endDate?)` → `{ commits[], branches[] }`.
- **Scope**: mixed (internal codebase + external GitHub API behavior)
- **Date**: 2026-06-04

---

## TL;DR Recommendation

**Use GraphQL (`@octokit/graphql`)**, not per-branch REST, for the commit-graph fetch.

- One GraphQL query fetches all branch tips + each tip's `history(since, until)` with `oid`, `parents`, `committedDate`, and `author.user { login avatarUrl }` in a single round trip (paginate only if a branch has >100 commits in range). For a ~10-branch / ~300-commit repo that is **1–3 requests** vs REST's **1 + N(branches) + pagination** (≈ 11–40 requests).
- GraphQL rate-limit cost for this shape is **tiny** (single-digit points out of 5000/hr); the REST 5000/hr budget is also fine but burns far more requests and is chattier.
- **Cache** the assembled `{ commits, branches }` in a **Firestore cache doc with a short TTL** (60–120 s) keyed by `repoId + startDate + endDate`, not in-memory (Cloud Functions instances are ephemeral and per-instance memory gives near-zero hit rate under autoscaling).
- **Merge/PR detection**: `parents.length >= 2` for merge commits; extract PR number from the commit message regex `^Merge pull request #(\d+)`; only fall back to `repos.listPullRequestsAssociatedWithCommit` (or GraphQL `Commit.associatedPullRequests`) for squash/rebase merges where the message has no `#N`. The GraphQL `associatedPullRequests(first:1)` can be inlined into the same query at near-zero extra cost — preferred over the REST fallback (which is 1 request per commit).
- **Branch cap**: fetch at most **~20 branches**, sorted by most-recently-committed tip. Commits whose parents fall outside the fetched window are kept as nodes with a `parents[]` that references SHAs not present in the returned set; the client treats a missing parent as "off-screen" (lane continues to an edge marker, no crash).

This matches the task's **D1 (on-demand Cloud Function, short-term caching, no Firestore schema change)** and keeps all GitHub access inside `githubClient.ts` (ARCHITECTURE §6.4).

---

## Internal context (confirmed in repo)

### Files Found

| File Path | Description |
|---|---|
| `functions/src/services/githubClient.ts` | The Octokit wrapper. Exports `getOctokit(token)`, `getRecentCommits` (maps `c.commit.message`, `c.author?.login`, `c.commit.author?.date` but **does NOT map `parents`**), `createIssue`, `verifyRepoAccess`, `registerWebhook`, `deleteWebhook`. New `getCommitGraph` helper belongs here. |
| `functions/src/handlers/addRepo.ts` | Shows the **token source**: `db.doc('apps/gitsync/users/{uid}').githubAccessToken` — a **user OAuth access token** (not a GitHub App installation token). `getCommitGraph`'s callable must read the caller's token the same way. |
| `functions/src/handlers/explainCommit.ts` | Sibling callable pattern: `onCall({ region: REGION, ... })`, auth guard (`request.auth`), pulls `{ repoId, sha, force }` from `request.data`, delegates to a flow. Mirror this shape for `getCommitGraph`. |
| `functions/src/flows/explainCommit.ts` | **Caching pattern to imitate**: reads a Firestore doc, returns `{ ..., cached: true }` on cache hit, does a best-effort write-back (`try/catch`, never fails the call on a failed cache write). |
| `functions/package.json` | Deps: `@octokit/rest@^21.0.2`, `firebase-admin@^12.7.0`, `firebase-functions@^6.0.1`. **`@octokit/graphql` is NOT yet a dependency** — must be added. (Octokit v21 transitively bundles `@octokit/graphql`, so `octokit.graphql(...)` is callable from the existing `Octokit` instance without a new top-level dep — see "Octokit GraphQL usage" below.) Note: `engines.node` is **"22"** here (task brief said Node 20 — minor discrepancy, runtime is 22). |
| `functions/src/handlers/githubWebhook.ts` | Confirms why this is needed: push payload commits carry **no parents** and branch only via top-level `ref`. PR docs live at `apps/gitsync/repos/{repoId}/pullRequests/{number}`. |

### Token type matters for rate limits
The token is a **user OAuth token** (`githubAccessToken` on the user doc), so:
- REST limit: **5,000 requests/hr** per user.
- GraphQL limit: **5,000 points/hr** per user (separate bucket from REST).
- Multiple users hitting different repos draw from **different** buckets (per-user). A single user repeatedly opening the graph is the realistic pressure case → caching solves it.

---

## 1. REST option — `listBranches` + per-branch `listCommits`

### Field confirmation (`octokit.repos.listCommits`)
`GET /repos/{owner}/{repo}/commits` accepts these query params (all confirmed in the REST docs):
- `sha` — SHA or **branch name** to start listing from (this is how you scope to a branch).
- `since` — ISO 8601 timestamp, only commits **after** this date.
- `until` — ISO 8601 timestamp, only commits **before** this date.
- `per_page` (max 100) + `page` for pagination.
- (also `author`, `path`, `committer` — not needed here.)

Each returned commit item **does** include:
- `sha` — the commit SHA.
- `commit.message`
- `commit.author.date` / `commit.committer.date` — the dates (`since`/`until` filter on **commit date**, i.e. committer date).
- `parents` — **array of `{ sha, url, html_url }`** ✅ (REST `listCommits` items DO carry `parents[]`).
- `author` — the **GitHub user** object (nullable) with `login` and **`avatar_url`** ✅ (top-level `author.avatar_url`, not `commit.author`). `commit.author` is the raw git name/email; `author` is the matched GitHub account. A commit with an unmatched email has `author: null` → must fall back to `commit.author.name` with no avatar.

So REST gives every field the payload needs. The cost is **request count**.

### Request-count math (≈10 branches, ≈300 commits in range)
- `listBranches`: 1 request (or more if >100 branches; rare).
- Per branch, `listCommits({ sha: branch, since, until })`: 1 request per 100 commits on that branch in range. With commits spread across 10 branches, expect **1 request per branch** in the common case → ~10 requests, more if any branch has >100 in-range commits.
- **Total ≈ 11–25 REST requests** per uncached graph load. Fine against 5000/hr, but chatty and higher latency (serial-ish unless you fan out with `Promise.all`).

### Dedupe + "primary branch" attribution
A commit reachable from multiple branches appears in multiple `listCommits` responses. To attribute a single "first seen on" branch:
- Build a `Map<sha, commit>` and record, for each sha, the **set** of branches whose `listCommits` returned it.
- **Primary-branch heuristic** (cheap, good enough for lane layout): process branches in a deterministic priority order — **default branch last** (so feature branches "claim" their own commits before main does), other branches ordered by tip commit date (newest first) or by name. First branch to surface a sha "owns" it. This approximates "the branch a commit was first developed on."
- A more accurate (but more expensive) attribution is a **first-parent walk** from each branch tip: follow `parents[0]` repeatedly; commits on a branch's first-parent chain that are not on the default branch's first-parent chain belong to that branch. This is what gives clean "forked here / merged here" lanes but requires having the full parent edges in memory (which you do after the fetch) — no extra API calls. **Recommended**: do the first-parent walk client-side or in the function over the already-fetched edge set; do not pay for extra requests.

---

## 2. GraphQL alternative (`@octokit/graphql`) — **recommended**

### Query shape (single round trip for the common case)
```graphql
query ($owner: String!, $name: String!, $since: GitTimestamp, $until: GitTimestamp) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    refs(refPrefix: "refs/heads/", first: 20,
         orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      nodes {
        name
        target {
          ... on Commit {
            history(since: $since, until: $until, first: 100) {
              nodes {
                oid
                message
                committedDate
                parents(first: 3) { nodes { oid } }
                author {
                  avatarUrl
                  user { login }     # nullable when email unmatched
                  name               # raw git name fallback
                }
                associatedPullRequests(first: 1) { nodes { number } }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    }
  }
}
```

Field notes (GraphQL schema names differ from REST):
- `oid` = the SHA (40-char). (`abbreviatedOid` also available.)
- `committedDate` (GitTimestamp). `history(since, until)` filters on commit date — same semantics as REST `since/until`.
- `parents(first: 3) { nodes { oid } }` — parent SHAs. `first: 3` comfortably covers normal (1) and merge (2) commits; octopus merges (3+) are rare; you can request `first: 5` for safety. `parents.totalCount` is also available if you want to detect octopus merges without fetching all parent oids.
- `author.avatarUrl` (string, top-level on the GitCommit author) and `author.user.login` (nullable — null when the commit email isn't linked to a GitHub account). `author.name` is the raw git name fallback.
- `associatedPullRequests(first: 1) { nodes { number } }` — **inline PR-number resolution at near-zero cost** (see §4). Covers squash/rebase merges that REST message-parsing misses.
- `refs(first: 20, orderBy: { field: TAG_COMMIT_DATE, direction: DESC })` — gives the **20 most-recently-committed branches** in one shot (implements the cap from §5). `refPrefix: "refs/heads/"` restricts to branches.

### Request count & rate-limit cost
- **Requests**: 1 query covers all 20 branches' histories. You only make additional requests if a branch's `history` has `hasNextPage` (>100 in-range commits on that branch) — for ~300 commits across 10 branches, almost always **1 request**, occasionally 2–3.
- **GraphQL point cost** (GitHub's documented node-cost formula): cost ≈ ceil over the number of nodes requested across connections, divided by 100, summed per connection, minimum 1 point. Concretely: `refs(first:20)` × `history(first:100)` is the dominant term → roughly `20 × 100 / 100 = ~20` nodes-worth → a **handful of points** (single digits to low tens). The nested `parents(first:3)` and `associatedPullRequests(first:1)` add negligibly. Against a **5,000 point/hr** budget this is ~0.1–0.5% per load. (The exact integer is returned in the response under `rateLimit { cost remaining }` if you add that field — recommended to log it once during dev.)

### Octokit GraphQL usage from the existing dep
You do **not** need to add a separate top-level package: `@octokit/rest` v21 ships an `Octokit` whose instance exposes `octokit.graphql(query, variables)` (the `@octokit/graphql` client is bundled and authenticated with the same token). Example inside `githubClient.ts`:
```ts
const octokit = getOctokit(accessToken);          // existing helper
const data = await octokit.graphql(QUERY, { owner, name, since, until });
```
If you prefer the standalone client, `@octokit/graphql`'s `graphql.defaults({ headers: { authorization: 'token ' + accessToken } })` is the documented pattern — but reusing `octokit.graphql` keeps one auth path and zero new deps. Errors come back as a thrown `GraphqlResponseError` with `.errors[]`; rate-limit exhaustion surfaces as an error with type `RATE_LIMITED` / a 403 — handle to satisfy the PRD "GitHub API failure shows error+retry" acceptance criterion.

### Conclusion: GraphQL wins
Fewer requests, trivial rate cost, single auth path, **and** it folds PR-number resolution and the branch cap into the same query. REST is a viable fallback but strictly chattier with no offsetting benefit here.

---

## 3. Rate limits + caching strategy

### Limits (user OAuth token)
- **REST**: 5,000 requests/hour/user. Headers `x-ratelimit-remaining` / `x-ratelimit-reset`. Octokit throws a 403/429 with these on exhaustion.
- **GraphQL**: 5,000 **points**/hour/user (independent bucket). Add `rateLimit { limit cost remaining resetAt }` to the query to read it inline. Secondary/abuse limits also apply (concurrent-request and content-creation limits) — not a concern for read-only single queries.
- A naive **uncached** implementation that refetches on every graph open is the real risk if a user toggles views or re-picks ranges repeatedly. Hence caching.

### Recommended cache: Firestore cache doc with short TTL (NOT in-memory)
- **Why not in-memory per instance**: Cloud Functions Gen2 autoscales and recycles instances; a per-instance `Map` cache has near-zero hit rate across separate cold instances and leaks memory if unbounded. Acceptable only as an opportunistic L1 with a hard size cap, never as the primary cache.
- **Firestore cache doc** (primary): write the assembled payload to e.g.
  `apps/gitsync/repos/{repoId}/graphCache/{cacheKey}` where
  `cacheKey = hash(startDate + '_' + endDate)` (or a literal `recent` key when no range).
  Store `{ payload, generatedAt, ttlSeconds }`. On call, read the doc; if `now - generatedAt < ttl` return `{ ...payload, cached: true }`, else refetch + overwrite. Mirror the **best-effort write-back** pattern from `flows/explainCommit.ts` (a failed cache write must not fail the call). Suggested **TTL 60–120 s** — long enough to absorb view toggles / re-picks, short enough that new pushes appear quickly. (Branch graphs tolerate slight staleness.)
- **ETag / conditional requests** (REST only, secondary optimization): `listCommits`/`listBranches` responses carry an `ETag`; sending `If-None-Match` yields a **304 Not Modified** that **does not count against the rate limit**. Useful if you stick with REST and want cheap freshness checks. **Not applicable to GraphQL** (no ETag/304 semantics) — another reason the Firestore-TTL cache is the right primary mechanism since it is transport-agnostic.

**Decision**: Firestore cache doc with ~90 s TTL as primary; optionally log GraphQL `rateLimit.cost` during dev. Skip ETag unless you choose REST.

---

## 4. Merge-commit + PR-number extraction

### Detect merge commits
- `parents.length >= 2` (REST: `commit.parents.length`; GraphQL: `parents.totalCount` or `parents.nodes.length`). Two parents = standard merge; 3+ = octopus (rare).

### Extract the merged PR number — layered, cheapest first
1. **Message regex (free, no extra calls)**: GitHub's classic merge-commit message is `Merge pull request #N from owner/branch`. Regex: `/^Merge pull request #(\d+)\b/`. This is the merge-commit strategy default and covers most merge nodes.
2. **GraphQL `associatedPullRequests(first: 1) { nodes { number } }` (near-free)**: already inlined in the §2 query. Resolves **squash** and **rebase** merges whose merge commit message is just the PR title (no `#N` at the start), and resolves the case where the visible commit *is* the squashed commit on the default branch. Strongly preferred over the REST fallback because it costs ~nothing extra in the same request.
3. **REST fallback `repos.listPullRequestsAssociatedWithCommit`** (`GET /repos/{owner}/{repo}/commits/{sha}/pulls`): returns PRs associated with a commit. **Cost: 1 REST request per commit you call it for** — expensive if applied broadly. Only use this if you stayed on REST *and* the message regex failed for a specific node. Do not loop it over all commits.

**Recommendation**: regex first (label merge nodes that have `#N`), GraphQL `associatedPullRequests` to fill the rest in the same query, REST endpoint not needed if on GraphQL.

---

## 5. Branch-list explosion + out-of-window parents

### Cap
- Fetch at most **~20 branches**, sorted by **most-recently-committed tip**.
  - GraphQL: `refs(refPrefix:"refs/heads/", first: 20, orderBy:{ field: TAG_COMMIT_DATE, direction: DESC })` does the sort+cap server-side in the same query.
  - REST: `listBranches` doesn't sort by commit date; you'd fetch branch list then sort client-side by each tip's date (extra cost) — another point for GraphQL.
- Always **include the default branch** even if it's not in the 20 most-recent (it's the trunk every lane forks from / merges to). `defaultBranchRef { name }` is in the query; union it into the fetched set.

### Commits whose parents fall outside the fetched window (`since`/`until` or branch cap)
- A node's `parents[]` may reference SHAs not present in the returned commit set (parent is older than `since`, or on an un-fetched branch). This is **expected** and is the documented out-of-scope limitation in the PRD ("commits only reachable from deleted branches" + window edges).
- Handling: the client lane-layout treats a parent SHA **not in the node map** as an **"off-screen" anchor** — draw the lane continuing to the top/bottom edge with a faded stub or "earlier history" marker; never assume the parent object exists. The function should return parents as **plain SHA strings**; resolution is "present in `commits[]` or not."
- Do **not** chase out-of-window parents with extra API calls — that defeats the date-range scoping and risks rate cost.

---

## Suggested response payload schema (`getCommitGraph` → `{ commits, branches }`)

```ts
interface CommitGraphResult {
  commits: GraphCommit[];   // time-ordered (committedAt desc or asc — pick one, document it)
  branches: GraphBranch[];
  cached: boolean;          // mirror explainCommit's { cached } convention
  truncated?: boolean;      // true if branch cap or per-branch history pagination was hit
}

interface GraphCommit {
  sha: string;
  message: string;          // full message; client takes first line for the dot label
  committedAt: string;      // ISO 8601 (from committedDate / commit.author.date)
  parents: string[];        // parent SHAs; a SHA not present in commits[] = off-screen
  author: {
    login: string | null;   // GitHub login, null when email unmatched
    name: string;           // raw git author name (fallback display)
    avatarUrl: string | null;
  };
  primaryBranch: string;    // attributed lane (first-seen heuristic / first-parent walk)
  isMerge: boolean;         // parents.length >= 2
  prNumber: number | null;  // from message regex or associatedPullRequests
}

interface GraphBranch {
  name: string;             // e.g. "feature/summary-intel-hub"
  tipSha: string;           // the ref's target oid
  isDefault: boolean;       // matches repository.defaultBranchRef.name
}
```

Notes for the implementer:
- `primaryBranch` is computed in the function (or returned per-commit as the branch set if you'd rather the client decide) — recommend computing it server-side via the first-parent-walk-over-fetched-edges so the client stays a dumb painter.
- Keep `getCommitGraph` in `githubClient.ts` (the Octokit boundary) returning the raw fetch, and do dedupe/attribution in a `flows/` module (mirrors `explainCommit` flow vs client split). The callable handler reads the caller's `githubAccessToken` exactly like `addRepo` does.

---

## Caveats / Not Found

- **MCP web-search tools (`mcp__exa__*`) were not available** in this agent's tool set, so external claims rest on knowledge of the GitHub REST/GraphQL docs (field names: REST `parents[]`, top-level `author.avatar_url`, `since/until/sha` params; GraphQL `oid`, `committedDate`, `parents.nodes.oid`, `author.avatarUrl`, `author.user.login`, `associatedPullRequests`, `refs.orderBy TAG_COMMIT_DATE`). These are stable, long-documented fields, but the implementer should **confirm the exact GraphQL `rateLimit.cost` integer** by adding `rateLimit { cost remaining }` to the query during dev, and **confirm `@octokit/rest` v21 exposes `octokit.graphql`** (it does in the Octokit core it bundles) before relying on it — otherwise add `@octokit/graphql` explicitly.
- **Node version discrepancy**: task brief said Node 20; `functions/package.json` `engines.node` is `"22"`. Not blocking (both support everything here) but noted.
- **`@octokit/graphql` is not currently a top-level dependency** — either use `octokit.graphql` from the bundled client (no install) or `npm i @octokit/graphql` in `functions/`.
- **Squash/rebase "first seen on a branch"** is inherently lossy after the branch is deleted — the on-demand approach (walking current branch heads) cannot show commits only reachable from deleted branches. This is already accepted as out-of-scope in the PRD.
- Exact GraphQL node-cost is an approximation here (GitHub's formula is "ceil(nodes/100) per connection, min 1, summed"); the real number is small and is best read from the live `rateLimit` field rather than trusted from this doc.
