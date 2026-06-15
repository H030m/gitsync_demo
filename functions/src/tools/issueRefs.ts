// Parsing GitHub issue references out of commit messages / PR titles+bodies.
//
// Two granularities:
//   - parseIssueRefs: any `#N` mention (used to LINK commits to tasks).
//   - parseClosingRefs: only closing-keyword forms (`close[sd]? / fix(e[sd])? /
//     resolve[sd]? #N`, case-insensitive) used to auto-COMPLETE tasks on PR
//     merge. GitHub's own "closing keywords" list is the model here.

// Closing keywords followed by `#N` (optionally `#N` immediately after the
// keyword + whitespace). Matches `closes #3`, `Fixed #12`, `resolve #7`, etc.
const CLOSING_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

// Any `#N` reference.
const HASH_RE = /#(\d+)\b/g;

function collect(text: string, re: RegExp): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return [...out];
}

/** Distinct issue numbers referenced by any `#N` mention in the text. */
export function parseIssueRefs(text: string | undefined | null): number[] {
  if (!text) return [];
  return collect(text, HASH_RE);
}

/** Distinct issue numbers referenced by a closing keyword (`closes #N`, ...). */
export function parseClosingRefs(text: string | undefined | null): number[] {
  if (!text) return [];
  return collect(text, CLOSING_RE);
}
