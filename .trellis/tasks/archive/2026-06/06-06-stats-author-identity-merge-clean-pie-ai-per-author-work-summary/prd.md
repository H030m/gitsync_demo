# Stats: author identity merge + clean pie + AI per-author work summary

## User feedback driving this

1. "H030m 倪嘉駿 都是我" / "temmie 也有兩個" — the commit-share pie splits one
   human into login-keyed and name-keyed buckets (GraphQL-backfilled commits
   can lack `author.login`; label fell back to the git `name`).
2. In-slice pie names removed (legend only).
3. 進度表 becomes: list ALL commit authors (all history) and use AI to
   summarize what each person worked on.

## Decisions

**D1 — Author canonicalization (frontend, pure).**
Build identity groups over all commits: commits carrying BOTH login+name
teach a name→login mapping (case-insensitive, trimmed); buckets keyed by
lowercase login when resolvable, else by normalized name. Display label =
the canonical GitHub login (original casing) when known, else the name.
Applies to the commit pie AND the new author list. Unit-tested with the
H030m/倪嘉駿 + temmie/Temmie shapes.

**D2 — Pie: no in-slice titles.** Legend chips only (name — NN%).

**D3 — 進度表 → per-author AI work summaries.**
* Rows = canonical authors from ALL commits, sorted by commit count desc:
  label + commit count + share bar.
* 詳細情形 expand → AI 工作總結 (markdown). On first expand call the new
  callable; afterwards cached (backend doc cache like explainCommit) with a
  regenerate button.
* New backend callable `summarizeAuthorWork`:
  - input { repoId, login?, names[], force? } (login may be empty for
    name-only buckets; names[] are the bucket's known git names).
  - auth required; reads up to ~100 newest commits matching author.login
    (case-insensitive compare in code after fetching by exact login, plus
    fallback name matching over a bounded recent window — keep it simple:
    fetch all commit docs (collection ≤ a few hundred) and filter in code).
  - prompt: commit messages + aiSummaries → short markdown (3-6 bullets:
    主要做了哪些模組/功能,用非技術人也懂的語言).
  - cache: repos/{repoId}/authorSummaries/{key} (key = sanitized login or
    name hash) storing markdown + commitCount + generatedAt; cache hit when
    !force AND stored commitCount == current count; return {markdown,
    cached}.
  - errors per error-handling.md; OpenAI via config singleton + zod NOT
    needed (plain text/markdown completion fine, mirror explainCommit).
* Caption swaps to something like: 每位作者的 commit 佔比與 AI 工作統整.
* Old task-progress rows are REMOVED (user redefined the tab). The
  task-based pie basis (任務 toggle) STAYS on the 貢獻度 tab.

## Acceptance Criteria

* [ ] One slice/row per human: H030m+倪嘉駿 merged, temmie merged (unit
  tests with these shapes).
* [ ] Pie has no in-slice text; legend intact.
* [ ] 進度表 lists every canonical author with commit count; expanding
  generates/loads the AI summary; regenerate works; second expand is cached.
* [ ] functions typecheck/lint/test + flutter analyze/test green.
* [ ] summarizeAuthorWork deployed.

## Out of Scope

* Editing identity mappings manually (auto-merge only).
* Summarizing non-commit work (tasks/discord) in the author summary.
