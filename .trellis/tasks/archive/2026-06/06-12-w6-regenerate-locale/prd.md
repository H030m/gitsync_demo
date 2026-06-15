# W6 — Regenerate AI artifacts in the app language (regenerate-with-locale)

> Final-demo sprint **W6**.
> Branch `feat/w6-regenerate-locale`, worktree `ssfinal/gitsync-w6`, base `feature/agentic-final-demo` (contains W1–W5).
> Full cycle owned by the implementer — **no separate review gate**. This PRD is the closed record (status `completed`).

---

## Goal

AI-generated CACHED artifacts are produced once in a fixed (default) language. Make them regenerate
in the **user's app language** — but ONLY on an explicit regenerate/recompute action, NOT by
pre-generating multiple language copies. First/auto/scheduled generation stays single + default and
**byte-identical** to today. When the user taps regenerate, the app's current locale is mapped to a
language name and threaded → flow → prompt → the output is forced into that language and overwrites the
cached doc.

**Hard invariants (zero change to existing behavior):**
- Result shapes unchanged: `{ handoffMarkdown, cached }`, `summarizeDay` report, `{ markdown, cached }`.
- Cache semantics + the `force` flag unchanged. `language` is independent of `force`; in practice the UI
  sends `language` together with `force=true` on a regenerate.
- When `language` is absent/empty the prompt is **byte-identical** to before → the auto trigger
  (`onTaskUpdated` handoff, `scheduledDailyReport`, first-tap explain) is completely unaffected.
- No Firestore schema change, no new npm/pub deps, no deploy.

---

## Scope — exactly these THREE artifacts

1. **Handoff doc** — `generateHandoff` (two-phase agentic, W1). The language directive must reach BOTH
   the Phase-1 drafting system prompt AND the Phase-2 reviewer system prompt (so the reviewer does not
   penalize a non-English draft, and re-injected gaps stay in that language).
2. **Daily report** — `summarizeDay`. The narrative (summary / highlights / blockers / commitThemes)
   honors the language; deterministic counts/contributions are computed in TS and stay language-neutral.
3. **Commit work summary** — `explainCommit`. System prompt on the doc path AND the GitHub-fallback path.

**Out of scope (untouched):** discordChat / dailyBrief / askRepo (already answer in the question's
language), discordDailyDigest, breakdownTask, summarizeAuthorWork, editDiscordDigest, W3 projectBrief
merge prompt.

---

## Language-value convention (chosen + documented)

The client sends a **human-readable English language NAME** derived from the active app locale:

| AppLocale | `Locale`     | backendLanguage        |
|-----------|--------------|------------------------|
| `en`      | `en`         | `"English"`            |
| `zhHant`  | `zh_TW`      | `"Traditional Chinese"`|

Rationale: a clear English language name is the simplest, most reliable signal for the model (it handles
either a name or a BCP-47 tag, but a name is least ambiguous). The map lives in
`AppLocaleX.backendLanguage` (single source of truth) and is surfaced through `AppStrings.backendLanguage`
(`context.l10n.backendLanguage`) so call sites use the same fallback-safe locale accessor as the rest of
the UI. The app supports exactly these two locales; the map extends trivially if more are added.

---

## Backend — language threading (per artifact)

The prompt change is a single CONDITIONAL line, appended only when `language?.trim()` is non-empty:

```
\nWrite your entire response in {language}.
```

Each prompt module gains a base string + a `*SystemPrompt(language?)` builder; absent/empty → returns the
base byte-identical. Each handler adds an OPTIONAL `language?: string` to its `request.data` shape,
validates `typeof language === 'string'` (when defined), and passes it through; each flow input gains
`language?: string`.

### 1. `prompts/generateHandoff.ts` + `flows/generateHandoff.ts` + `handlers/generateHandoff.ts`
- `generateHandoffSystem` → `generateHandoffSystemBase` + `generateHandoffSystemPrompt(language?)`.
- `handoffReviewSystem` → `handoffReviewSystemBase` + `handoffReviewSystemPrompt(language?)`.
- Shared `withLanguage(systemPrompt, language?)` helper.
- Flow: `GenerateHandoffInput.language?`; Phase-1 system uses `generateHandoffSystemPrompt(language)`;
  `reviewDraft(args.language)` uses `handoffReviewSystemPrompt(args.language)`.
- Handler: pass `language` into `generateHandoffFlow({ ..., force: true, runId, language })`.

### 2. `prompts/summarizeDay.ts` + `flows/summarizeDay.ts` + `handlers/summarizeDay.ts`
- `summarizeDaySystem` → `summarizeDaySystemBase` + `summarizeDaySystemPrompt(language?)`.
- Flow: `SummarizeDayInput.language?` → `runReportAgent(..., language)` → narrative system prompt.
  Step-1 deterministic context (counts/contributions) untouched.
- Handler: validate + pass `language` into `summarizeDayFlow`.

### 3. `prompts/explainCommit.ts` + `flows/explainCommit.ts` + `handlers/explainCommit.ts`
- `explainCommitSystem` → `explainCommitSystemBase` + `explainCommitSystemPrompt(language?)`.
- Flow: `ExplainCommitInput.language?`; both the doc path and `explainFromGitHub(...)` use
  `explainCommitSystemPrompt(language)`.
- Handler: validate + pass `language` through.

---

## Frontend — regenerate wiring + locale→name mapping

- **Locale source:** `LocaleNotifier` / `context.l10n`. New `AppLocaleX.backendLanguage` (tiny map) +
  `AppStrings.backendLanguage` (fallback-safe accessor).
- **`FunctionsService`** (+ `_LiveFunctionsService`): three calls gain optional `String? language`,
  sent via the `'language': ?language` conditional-map-entry shorthand (only sent when set).
- **`FakeFunctionsService`:** same signatures; when `language` is set the canned data is annotated
  (`Regenerated/Recomputed in {language} — fake demo.`) so a regenerate is visibly different in fake mode.
- **Daily report regenerate** (`daily_view_page.dart` → `daily_report_vm.dart`): `generateDay` / `regenerate`
  gain `{String? language}`; the per-day "Generate report" + "Regenerate" buttons pass
  `context.l10n.backendLanguage`.
- **Commit recompute** (`commits_vm.dart`, commit detail sheet in `daily_view_page.dart`):
  `explain(sha, {force, language})`; the refresh/recompute IconButton passes `s.backendLanguage`
  (`force: true`). First-tap auto explanation sends NO language (default path).
- **Handoff regenerate** (`task_details_page.dart`): a regenerate/force button **already existed**
  (`_regenerateHandoff`, force=true) — wired to pass `s.backendLanguage`. No new action added.

CLAUDE.md rule: no new colors/hardcoded styling introduced; the wired controls reuse existing
`colorScheme`-based widgets (light + dark compliant). i18n: no new user-facing strings were required
(the regenerate buttons already had l10n labels); `backendLanguage` is a backend signal, not UI copy.

---

## Fake-mode behavior

`FakeFunctionsService` returns canned data; when `language` is non-empty it appends a small note so a
demo regenerate visibly changes. No backend/secrets needed to demo the wiring.

---

## Test plan

**Backend (jest, boundary-mock style):**
- `generateHandoff.test.ts`: language present → the directive appears in BOTH phase system prompts
  (Phase 1 via `chat.completions.create`, Phase 2 via `beta.chat.completions.parse`); language absent →
  no directive and the present run = base + exactly one line; whitespace-only language → no directive.
- `summarizeDay.test.ts`: language present → narrative system prompt carries the directive; absent →
  byte-identical base + with-language run appends exactly one line.
- `explainCommit.test.ts`: language present → directive appended; absent → base + with-language appends
  one line; language threads into the GitHub-fallback path too.

**Flutter:**
- `regenerate_locale_test.dart` (new): `AppLocale.en/zhHant → backendLanguage` mapping;
  `DailyReportViewModel.generateDay`/`regenerate` forward the mapped language (or none) to `summarizeDay`.
- `commits_vm_test.dart`: recompute (`force`) forwards the mapped language to `explainCommit`; first tap
  sends none.
- Existing test fakes (`daily_discord_tab_test.dart`, `repo_list_vm_test.dart`) updated for the new
  optional param so the suite stays green.

---

## Risks

- **Reviewer JSON vs language line:** the Phase-2 reviewer returns JSON `{score, gaps}`; the language line
  could lead it to write `gaps` in that language — which is desirable (gaps are re-injected into the
  redraft). `score` stays numeric. Acceptable.
- **First/auto generation:** UI "Generate report" / first-tap explain must NOT regress the default path —
  guaranteed by the absent/empty → byte-identical prompt (regression-tested per artifact). The auto
  trigger / scheduled report never send `language`.
- **Merge:** `generateHandoff.ts` / `summarizeDay.ts` are W1 / W3 touch points; changes here are additive
  (new optional param + prompt builder) so conflicts are unlikely but flagged.

---

## Out of scope

discordChat / dailyBrief / askRepo / discordDailyDigest / breakdownTask / summarizeAuthorWork /
editDiscordDigest / W3 projectBrief merge prompt. No Firestore changes, no new deps, no deploy.

---

## Result

- Backend: typecheck 0 / lint 0 / jest **37 suites, 318 tests** (baseline 310, +8).
- Flutter: analyze **3 pre-existing** issues (no new); test **91 pass + 1 pre-existing fail** (baseline 85,
  +6, no new failures).
- No generated plugin-registrant files committed. Self-reviewed against the design + `.trellis/spec`
  backend/frontend guidelines; no defects found.
