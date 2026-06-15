// Wraps Octokit so every GitHub API call lives in one place
// (ARCHITECTURE.md §6.4).
//
// Any future GitHub interaction (create issue, get PR diff, etc.) belongs in
// this file — keep the rest of the codebase free of `@octokit/rest` imports.
import { Octokit } from '@octokit/rest';

export function getOctokit(userAccessToken: string): Octokit {
  return new Octokit({ auth: userAccessToken });
}

export interface RecentCommit {
  sha: string;
  message: string;
  authorLogin: string;
  authorName: string;
  authorEmail: string;
  url: string;
  committedAt: string;
}

export async function getRecentCommits(
  owner: string,
  repo: string,
  accessToken: string,
  limit = 20,
): Promise<RecentCommit[]> {
  const octokit = getOctokit(accessToken);
  const res = await octokit.repos.listCommits({
    owner,
    repo,
    per_page: limit,
  });
  return res.data.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
    authorLogin: c.author?.login ?? '',
    authorName: c.commit.author?.name ?? '',
    authorEmail: c.commit.author?.email ?? '',
    url: c.html_url,
    committedAt: c.commit.author?.date ?? '',
  }));
}

export interface CommitDetail {
  sha: string;
  message: string;
  authorLogin: string;
  authorName: string;
  committedAt: string;
  files: string[];
  additions: number;
  deletions: number;
}

/**
 * Fetches a single commit (GET /repos/{owner}/{repo}/commits/{sha}) with its
 * message, author, changed file paths and line stats. Used by explainCommit's
 * fallback path when no Firestore commit doc exists (06-05 D2). All GitHub API
 * access stays in this file (ARCHITECTURE.md §6.4).
 */
export async function getCommit(
  owner: string,
  repo: string,
  accessToken: string,
  sha: string,
): Promise<CommitDetail> {
  const octokit = getOctokit(accessToken);
  const res = await octokit.repos.getCommit({ owner, repo, ref: sha });
  const data = res.data;
  return {
    sha: data.sha,
    message: data.commit.message,
    authorLogin: data.author?.login ?? '',
    authorName: data.commit.author?.name ?? '',
    committedAt: data.commit.author?.date ?? '',
    files: (data.files ?? []).map((f) => f.filename),
    additions: data.stats?.additions ?? 0,
    deletions: data.stats?.deletions ?? 0,
  };
}

export interface CommitDiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff for this file; null for binary files or once truncated. */
  patch: string | null;
}

export interface CommitDiff {
  sha: string;
  message: string;
  files: CommitDiffFile[];
  /** True when later files' patches were dropped to stay under the char cap. */
  truncated: boolean;
}

/**
 * Fetches a single commit's unified diff (GET /repos/{owner}/{repo}/commits/{sha})
 * keeping the per-file `patch` text that {@link getCommit} deliberately strips.
 * Files are walked in order, accumulating patch characters; once the running
 * total would exceed `maxPatchChars` the remaining files keep their metadata but
 * get `patch: null` and `truncated` is set — this bounds one commit's diff to a
 * predictable budget (the handoff agent's getCommitDiff tool). Binary files
 * (no patch from GitHub) also surface as `patch: null`. All GitHub API access
 * stays in this file (ARCHITECTURE.md §6.4).
 */
export async function getCommitDiff(
  owner: string,
  repo: string,
  accessToken: string,
  sha: string,
  maxPatchChars: number,
): Promise<CommitDiff> {
  const octokit = getOctokit(accessToken);
  const res = await octokit.repos.getCommit({ owner, repo, ref: sha });
  const data = res.data;

  let used = 0;
  let truncated = false;
  const files: CommitDiffFile[] = (data.files ?? []).map((f) => {
    const patch = typeof f.patch === 'string' ? f.patch : null;
    if (patch === null) {
      return {
        filename: f.filename,
        status: f.status ?? '',
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        patch: null,
      };
    }
    if (truncated || used + patch.length > maxPatchChars) {
      truncated = true;
      return {
        filename: f.filename,
        status: f.status ?? '',
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        patch: null,
      };
    }
    used += patch.length;
    return {
      filename: f.filename,
      status: f.status ?? '',
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      patch,
    };
  });

  return {
    sha: data.sha,
    message: data.commit.message,
    files,
    truncated,
  };
}

// ---- Commit graph (branch topology) ----------------------------------------

export interface GraphCommitRaw {
  sha: string;
  message: string;
  committedAt: string; // ISO 8601
  parents: string[];
  authorLogin: string | null; // null when the commit email isn't a GitHub user
  authorName: string;
  avatarUrl: string | null;
  associatedPrNumber: number | null;
}

export interface GraphBranchRaw {
  name: string;
  tipSha: string;
  isDefault: boolean;
  /** History scoped to the since/until window, newest first. */
  commits: GraphCommitRaw[];
  /** True when the branch had more in-window commits than we fetched. */
  truncated: boolean;
}

/** Branch cap — the N most-recently-committed branches (+ default branch). */
const GRAPH_BRANCH_LIMIT = 20;
/** Per-branch history page size (no pagination beyond the first page). */
const GRAPH_HISTORY_LIMIT = 100;

// One round trip: every branch tip + its in-window history with parent SHAs
// and author avatar. PR numbers come from the merge-commit message regex in
// the flow (`^Merge pull request #N`) — we deliberately do NOT fetch
// associatedPullRequests here: at refs(first:20) × history(first:100) it was
// ~2000 nested PR lookups per call, riding GitHub's ~10s GraphQL limit and
// returning 502s (06-05). See task research `github-api-commit-graph.md`.
const COMMIT_GRAPH_QUERY = `
  query ($owner: String!, $name: String!, $since: GitTimestamp, $until: GitTimestamp) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        name
        target { ...CommitHistory }
      }
      refs(refPrefix: "refs/heads/", first: ${GRAPH_BRANCH_LIMIT},
           orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
        nodes {
          name
          target { ...CommitHistory }
        }
        pageInfo { hasNextPage }
      }
    }
  }
  fragment CommitHistory on GitObject {
    ... on Commit {
      oid
      history(since: $since, until: $until, first: ${GRAPH_HISTORY_LIMIT}) {
        nodes {
          oid
          message
          committedDate
          parents(first: 5) { nodes { oid } }
          author {
            avatarUrl
            name
            user { login }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }
`;

interface GraphQlCommitNode {
  oid: string;
  message: string;
  committedDate: string;
  parents: { nodes: Array<{ oid: string }> };
  author: {
    avatarUrl: string | null;
    name: string | null;
    user: { login: string } | null;
  } | null;
}

interface GraphQlRefTarget {
  oid?: string;
  history?: {
    nodes: GraphQlCommitNode[];
    pageInfo: { hasNextPage: boolean };
  };
}

interface CommitGraphQueryResult {
  repository: {
    defaultBranchRef: { name: string; target: GraphQlRefTarget | null } | null;
    refs: {
      nodes: Array<{ name: string; target: GraphQlRefTarget | null }>;
      pageInfo: { hasNextPage: boolean };
    };
  } | null;
}

function toGraphCommitRaw(n: GraphQlCommitNode): GraphCommitRaw {
  return {
    sha: n.oid,
    message: n.message,
    committedAt: n.committedDate,
    parents: n.parents.nodes.map((p) => p.oid),
    authorLogin: n.author?.user?.login ?? null,
    authorName: n.author?.name ?? '',
    avatarUrl: n.author?.avatarUrl ?? null,
    // Bulk query no longer fetches associatedPullRequests (it was the dominant
    // cost behind the 502s). Kept on the raw shape so the flow/payload contract
    // is unchanged; merge PR numbers now come from the message regex in the flow.
    associatedPrNumber: null,
  };
}

/** Delay (ms) before the single retry in {@link fetchCommitGraph}. */
const GRAPH_RETRY_DELAY_MS = 500;

/**
 * True for transient GraphQL failures worth one retry: an HTTP 5xx (GitHub's
 * ~10s GraphQL limit surfaces as a 502) or a network-ish error with no status.
 */
function isTransientGraphError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === 'number') return status >= 500;
  return true; // no status → network/abort error → retry once
}

/**
 * Fetches the branch-topology raw data (branch tips + per-branch in-window
 * history with parent SHAs) in a single GraphQL round trip. Dedupe/lane
 * attribution is the flow's job (`flows/getCommitGraph.ts`) — this stays a
 * pure fetch, like every other helper in this file.
 *
 * Retries the GraphQL call once on a transient (5xx/network) failure with a
 * short delay — GitHub's ~10s limit returns intermittent 502s under load.
 */
export async function fetchCommitGraph(
  owner: string,
  repo: string,
  accessToken: string,
  options: { since?: string; until?: string } = {},
): Promise<{
  branches: GraphBranchRaw[];
  defaultBranch: string | null;
  /** True when the repo has more branches than the cap. */
  branchesTruncated: boolean;
}> {
  const octokit = getOctokit(accessToken);
  const variables = {
    owner,
    name: repo,
    since: options.since ?? null,
    until: options.until ?? null,
  };

  let data: CommitGraphQueryResult;
  try {
    data = await octokit.graphql<CommitGraphQueryResult>(
      COMMIT_GRAPH_QUERY,
      variables,
    );
  } catch (err) {
    if (!isTransientGraphError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, GRAPH_RETRY_DELAY_MS));
    data = await octokit.graphql<CommitGraphQueryResult>(
      COMMIT_GRAPH_QUERY,
      variables,
    );
  }

  // A partial/abnormal GraphQL response can arrive with `data` (or
  // `data.repository`) undefined — treat that as an empty result, never a
  // TypeError (06-05).
  const repository = data?.repository;
  if (!repository) {
    return { branches: [], defaultBranch: null, branchesTruncated: false };
  }
  const defaultBranch = repository.defaultBranchRef?.name ?? null;

  const toBranch = (
    name: string,
    target: GraphQlRefTarget | null,
  ): GraphBranchRaw => ({
    name,
    tipSha: target?.oid ?? '',
    isDefault: name === defaultBranch,
    commits: (target?.history?.nodes ?? []).map(toGraphCommitRaw),
    truncated: target?.history?.pageInfo.hasNextPage ?? false,
  });

  const branches: GraphBranchRaw[] = repository.refs.nodes
    .filter((ref) => ref.target?.history)
    .map((ref) => toBranch(ref.name, ref.target));

  // The branch cap is "20 most recently committed" — make sure the trunk every
  // lane forks from / merges to is always present even when it falls outside.
  const dbr = repository.defaultBranchRef;
  if (dbr?.target?.history && !branches.some((b) => b.name === dbr.name)) {
    branches.push(toBranch(dbr.name, dbr.target));
  }

  return {
    branches,
    defaultBranch,
    branchesTruncated: repository.refs.pageInfo.hasNextPage,
  };
}

export interface CreateIssueOptions {
  title: string;
  body: string;
}

/**
 * Creates a GitHub issue (POST /repos/{owner}/{repo}/issues) and returns the
 * created issue number + html url. Used by `onTaskCreated` to mirror a task as
 * an issue so commits/PRs can reference it via `#N`. All GitHub API access stays
 * in this file (ARCHITECTURE.md §6.4).
 */
export async function createIssue(
  owner: string,
  repo: string,
  accessToken: string,
  options: CreateIssueOptions,
): Promise<{ number: number; htmlUrl: string }> {
  const octokit = getOctokit(accessToken);
  const res = await octokit.issues.create({
    owner,
    repo,
    title: options.title,
    body: options.body,
  });
  return { number: res.data.number, htmlUrl: res.data.html_url };
}

/**
 * Replaces the assignees on a GitHub issue (PATCH
 * /repos/{owner}/{repo}/issues/{number} with `assignees`). Pass an empty array
 * to clear. Used to keep a task's linked GitHub issue assignee in sync with the
 * in-app assignee. All GitHub API access stays in this file (ARCHITECTURE.md §6.4).
 */
export async function setIssueAssignees(
  owner: string,
  repo: string,
  accessToken: string,
  issueNumber: number,
  assignees: string[],
): Promise<void> {
  const octokit = getOctokit(accessToken);
  await octokit.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    assignees,
  });
}

export interface Collaborator {
  login: string;
  avatarUrl: string | null;
}

/**
 * Lists a repo's GitHub collaborators (GET /repos/{owner}/{repo}/collaborators).
 * Used to import teammates as GitSync repo members. Requires the token holder to
 * have at least pull access; Octokit throws (status 403/404) otherwise. All
 * GitHub API access stays in this file (ARCHITECTURE.md §6.4).
 */
export async function listCollaborators(
  owner: string,
  repo: string,
  accessToken: string,
): Promise<Collaborator[]> {
  const octokit = getOctokit(accessToken);
  const res = await octokit.repos.listCollaborators({ owner, repo, per_page: 100 });
  return res.data.map((c) => ({
    login: c.login,
    avatarUrl: c.avatar_url ?? null,
  }));
}

/**
 * Closes a GitHub issue (PATCH /repos/{owner}/{repo}/issues/{number} with
 * `state: 'closed'`). GitHub's REST API can't *delete* issues, so deleting a
 * GitSync task closes its mirrored issue instead. Best-effort caller. All GitHub
 * API access stays in this file (ARCHITECTURE.md §6.4).
 */
export async function closeIssue(
  owner: string,
  repo: string,
  accessToken: string,
  issueNumber: number,
): Promise<void> {
  const octokit = getOctokit(accessToken);
  await octokit.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    state: 'closed',
  });
}

export interface RepoAccess {
  githubRepoId: number;
  defaultBranch: string;
  // GitHub permission flags on the repo for the authenticated user.
  // The caller decides whether push/admin is sufficient.
  permissions: {
    admin: boolean;
    push: boolean;
    pull: boolean;
  };
}

/**
 * Verifies the repo exists and is visible to the token holder, returning its
 * id, default branch, and the caller's permission flags. Throws (via Octokit)
 * with `status === 404` when the repo doesn't exist or isn't visible.
 */
export async function verifyRepoAccess(
  owner: string,
  repo: string,
  accessToken: string,
): Promise<RepoAccess> {
  const octokit = getOctokit(accessToken);
  const res = await octokit.repos.get({ owner, repo });
  const perms = res.data.permissions;
  return {
    githubRepoId: res.data.id,
    defaultBranch: res.data.default_branch,
    permissions: {
      admin: perms?.admin ?? false,
      push: perms?.push ?? false,
      pull: perms?.pull ?? false,
    },
  };
}

export interface RegisterWebhookOptions {
  url: string;
  secret: string;
  events: string[];
}

/**
 * Registers a `web` webhook on the repo (POST /repos/{owner}/{repo}/hooks) and
 * returns the created hook id. All GitHub API access stays in this file
 * (ARCHITECTURE.md §6.4).
 */
export async function registerWebhook(
  owner: string,
  repo: string,
  accessToken: string,
  options: RegisterWebhookOptions,
): Promise<number> {
  const octokit = getOctokit(accessToken);
  const res = await octokit.repos.createWebhook({
    owner,
    repo,
    name: 'web',
    active: true,
    events: options.events,
    config: {
      url: options.url,
      secret: options.secret,
      content_type: 'json',
    },
  });
  return res.data.id;
}

/**
 * Deletes a webhook on the repo (DELETE /repos/{owner}/{repo}/hooks/{hook_id}).
 * The inverse of {@link registerWebhook}; requires admin/push permission, same
 * as registration. All GitHub API access stays in this file (ARCHITECTURE.md §6.4).
 */
export async function deleteWebhook(
  owner: string,
  repo: string,
  accessToken: string,
  hookId: number,
): Promise<void> {
  const octokit = getOctokit(accessToken);
  await octokit.repos.deleteWebhook({ owner, repo, hook_id: hookId });
}

// ---- Repo contents (read-only file/dir access for tools/repoDocs) ----------

/** One entry in a directory listing (GET /repos/{owner}/{repo}/contents/{dir}). */
export interface RepoEntry {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size: number;
}

/**
 * Lists a directory's entries via the contents API
 * (GET /repos/{owner}/{repo}/contents/{path}). Returns `[]` when the path is
 * missing (404) — callers treat "no docs" as normal, not an error. Non-file/dir
 * entries (`submodule`/`symlink`) are dropped defensively. A file path (not a
 * dir) also yields `[]`. All GitHub API access stays in this file
 * (ARCHITECTURE.md §6.4).
 */
export async function listRepoDir(
  owner: string,
  repo: string,
  accessToken: string,
  path: string,
): Promise<RepoEntry[]> {
  const octokit = getOctokit(accessToken);
  try {
    const res = await octokit.repos.getContent({ owner, repo, path });
    if (!Array.isArray(res.data)) return []; // a file, not a directory
    return res.data
      .filter((e) => e.type === 'file' || e.type === 'dir')
      .map((e) => ({
        path: e.path,
        name: e.name,
        type: e.type as 'file' | 'dir',
        size: e.size ?? 0,
      }));
  } catch (err) {
    if ((err as { status?: number } | null)?.status === 404) return [];
    throw err;
  }
}

/**
 * Fetches one text file's decoded UTF-8 content via the contents API
 * (GET /repos/{owner}/{repo}/contents/{path}). Returns `null` on 404, when the
 * path is a directory rather than a file, or when the file's size exceeds
 * `maxBytes` (the caller's hard cap — larger files are skipped, never
 * truncated-and-read). All GitHub API access stays in this file
 * (ARCHITECTURE.md §6.4).
 */
export async function getRepoFile(
  owner: string,
  repo: string,
  accessToken: string,
  path: string,
  maxBytes: number,
): Promise<string | null> {
  const octokit = getOctokit(accessToken);
  let data;
  try {
    const res = await octokit.repos.getContent({ owner, repo, path });
    data = res.data;
  } catch (err) {
    if ((err as { status?: number } | null)?.status === 404) return null;
    throw err;
  }
  // A directory comes back as an array; only single files carry `content`.
  if (Array.isArray(data) || data.type !== 'file') return null;
  if (typeof data.size === 'number' && data.size > maxBytes) return null;
  if (typeof data.content !== 'string') return null;
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

// ---- PR triage helpers (06-08 onPullRequestOpened) -------------------------

export interface PullRequestFile {
  filename: string;
  additions: number;
  deletions: number;
  status: string;
  /** A unified-diff snippet, omitted by GitHub for huge/binary files. */
  patch: string | null;
}

/**
 * Lists the files changed by a PR
 * (GET /repos/{owner}/{repo}/pulls/{pull_number}/files). One page only — the
 * triage flow caps at the top N files by additions+deletions anyway. All
 * GitHub API access stays in this file (ARCHITECTURE.md §6.4).
 */
export async function listPullRequestFiles(
  owner: string,
  repo: string,
  accessToken: string,
  prNumber: number,
  perPage = 100,
): Promise<PullRequestFile[]> {
  const octokit = getOctokit(accessToken);
  const res = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: perPage,
  });
  return res.data.map((f) => ({
    filename: f.filename,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    status: f.status ?? '',
    patch: f.patch ?? null,
  }));
}

export interface PathCommitAuthor {
  sha: string;
  authorLogin: string;
  committedAt: string; // ISO 8601
}

/**
 * Lists the most recent commits that touched a path
 * (GET /repos/{owner}/{repo}/commits?path=...). Used by the PR triage flow to
 * rank reviewers by file-history (who has historically touched these files).
 * All GitHub API access stays in this file (ARCHITECTURE.md §6.4).
 */
export async function listCommitsForPath(
  owner: string,
  repo: string,
  accessToken: string,
  path: string,
  perPage = 10,
): Promise<PathCommitAuthor[]> {
  const octokit = getOctokit(accessToken);
  const res = await octokit.repos.listCommits({
    owner,
    repo,
    path,
    per_page: perPage,
  });
  return res.data.map((c) => ({
    sha: c.sha,
    authorLogin: c.author?.login ?? '',
    committedAt: c.commit.author?.date ?? '',
  }));
}
