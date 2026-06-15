# Rebuild Stats per prototype — contribution pie + progress table

## Background

The previous Stats build (06-06, four fl_chart cards) does not match the
design prototype `D:\SSFinal\references\GitSync\src\app\pages\stats\StatsView.tsx`.
User instruction: scrap it and rebuild faithful to the prototype.

## The prototype (source of truth)

Title「統計」+ two MD3 primary tabs:

**Tab 1 — 貢獻度**
* A PIE chart (radius ~90 in a 240 box): one slice per member, member NAME
  rendered inside the slice; small center hole with「貢獻度」/「圓餅圖」two-line
  label.
* Legend chips below: `● Name — NN%`.
* Caption card below the chart:「已完成的任務累計的貢獻度」.
* DATA: per member share of COMPLETED (done) tasks — pct = member's done
  count / total done count.

**Tab 2 — 進度表**
* One row per member inside a single card: name (left) + `NN%` (right,
  accent), MD3 linear progress bar underneath.
* A「詳細情形」toggle (chevron-right ↔ chevron-down) under each bar expands
  that member's TASK LIST: small dot + task title; DONE tasks struck-through
  and dimmed, pending tasks normal.
* Caption card:「每個人當前未完成任務的進度」.
* DATA: per member, pct = done / (all tasks assigned to them); the expanded
  list shows all their tasks (done + pending).

## Requirements

1. **Scrap** the four-chart layout (donut/author-bars/trend/member-load) and
   the matching VM derivations + their tests.
2. `StatsViewModel` derives, from tasks + member roster:
   * `contributions`: per member {label, doneCount, pct of total done}.
   * `memberProgress`: per member {label, pct done of own assigned, ordered
     task list (title, done)}.
   * Member display names: resolve via the same mechanism other UI uses for
     assignee names (inspect MembersViewModel / task assign dialog; fall back
     to userId when unnamed). Unassigned tasks are excluded.
3. `StatsViewPage`: AppBar「統計」+ TabBar(貢獻度/進度表) per the theme's
   central TabBar styling.
   * 貢獻度: fl_chart PieChart, name labels inside slices
     (badge/titlePositionPercentageOffset), centerSpaceRadius small with the
     two-line center label, legend chips row, caption card. Categorical
     colors: a small palette derived per theme (light: primary-blues family;
     dark: the dark accent family) — mirror the prototype's intent via
     colorScheme, no hardcoded hexes beyond an ordered palette constant if
     colorScheme can't express it.
   * 進度表: rows with name/pct/LinearProgressIndicator + expandable
     詳細情形 task list (strikethrough done), caption card.
   * Empty states: no members/tasks → friendly hint per tab.
4. Tests: VM unit tests (contribution pct math incl. zero-done edge,
   progress pct + task ordering, name fallback); widget test: tabs render,
   pie tab shows legend %, progress tab expands 詳細情形 and shows
   strikethrough done tasks.

## Acceptance Criteria

* [ ] Stats page = exactly two tabs 貢獻度/進度表 matching the prototype's
  structure, captions included.
* [ ] Contribution pie shows per-member share of done tasks with in-slice
  names + legend percentages.
* [ ] Progress rows expand to per-member task lists with struck-through done
  items.
* [ ] Old four-chart code + tests fully removed.
* [ ] flutter analyze (known info only) + flutter test green.

## Out of Scope

* Commits-based stats (the prototype has none).
* Backend changes.
