// Shared GitHub URL / slug parser. Used by the addRepo callable and the
// setRepoChannel onRequest endpoint to derive a stable `repoId`
// (`${owner}_${repo}`) from a repo URL the user / bot supplies.

export interface ParsedRepo {
  owner: string;
  repo: string;
}

/**
 * Parses common GitHub URL / slug formats into `{ owner, repo }`:
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo.git
 *   - git@github.com:owner/repo.git
 *   - owner/repo
 * Returns null when the input can't be resolved to owner/repo.
 */
export function parseGithubUrl(input: string): ParsedRepo | null {
  let s = input.trim();
  if (!s) return null;

  // Strip protocol / host so we can match a trailing owner/repo for both URL
  // and SSH forms.
  s = s
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^github\.com\//i, '');

  // Drop trailing slash and a trailing .git suffix.
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '');

  const parts = s.split('/').filter((p) => p.length > 0);
  if (parts.length !== 2) return null;

  const [owner, repo] = parts;
  // Reject obviously invalid path segments.
  const valid = /^[A-Za-z0-9._-]+$/;
  if (!valid.test(owner) || !valid.test(repo)) return null;

  return { owner, repo };
}
