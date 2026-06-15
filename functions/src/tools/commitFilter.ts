// Filters out commit messages that should NOT be embedded.
// Without this, the vector store fills up with `Merge branch ...`,
// `Bump version`, `Update README.md` etc. → wastes embedding tokens AND
// pollutes semantic search results.
//
// Logic mirrors ARCHITECTURE.md §5.6 "filter commit messages before embedding".

const SKIP_PATTERNS: RegExp[] = [
  /^Merge branch\b/i,
  /^Merge pull request\b/i,
  /^Merge remote-tracking branch\b/i,
  /^Revert ".*"/,
  /^chore\((release|deps|version)\):/i,
  /^v?\d+\.\d+\.\d+/,
  /^Initial commit$/i,
  /^Update README\.md$/i,
  /^Update \.gitignore$/i,
  /^Auto-merge/i,
  /^Automated commit/i,
  /^\[bot\]/i,
];

export function shouldSkipEmbedding(message: string): boolean {
  const firstLine = message.split('\n')[0]?.trim() ?? '';
  if (firstLine.length < 5) return true;
  return SKIP_PATTERNS.some((re) => re.test(firstLine));
}
