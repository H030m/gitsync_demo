# fix(tests): pin widget-test locale to English so i18n switch doesn't break finders

## Goal

Restore the 17 pre-existing widget-test failures to passing by pinning
the widget-test locale to English. The tests look for English text
literals like `"Commits"` and `"Discord digest · 2026-06-04"`, but the
upstream i18n commit (`5b7e562 feat(i18n): switchable Traditional
Chinese / English with Settings toggle`) switched the app's default
locale to Traditional Chinese (`zh-TW`), so the same UI now renders as
`"提交紀錄"` and `"Discord 摘要 · 2026-06-04"`. Finders return zero matches,
tests crash.

## Root cause (diagnosed 2026-06-14)

Confirmed by per-file runs of the failing suites:
* `test/commits_tree_test.dart` — 8 fails, every one is a
  `find.text("Commits")` / similar English label that no longer matches.
* `test/discord_digest_test.dart` — 3 fails, all
  `find.text("Discord digest · …")` vs new `"Discord 摘要 · …"`.
* `test/daily_summary_tab_test.dart` — 3 fails, same shape.
* `test/chat_test.dart` — 1 fail, same shape.
* Plus 2 more flaky/order-dependent fails (likely shared cause) that
  appear under `flutter test` whole-suite runs but pass in isolation —
  same i18n cause; the pin will incidentally stabilise them.

Total: 17 failures, single root cause.

The default-locale resolution in `MaterialApp` follows the device locale
when no `locale:` override is set. In CI / dev tests it now resolves to
`zh-TW` because the i18n delegate registers it as supported and the host
system likely lists it ahead of `en` for one of the contributors. None
of the failing tests set an explicit `locale:` — they pumped whatever
default rendered.

## Decisions (locked 2026-06-14)

* **Strategy A — pin test locale to English.** Each failing test's
  `pumpWidget(...)` wraps the widget tree in (or already constructs) a
  `MaterialApp`; add `locale: const Locale('en')` to those `MaterialApp`s,
  plus `localizationsDelegates` / `supportedLocales` if the app shell
  isn't already providing them via the configured app shell.
* **Why not change finders to Chinese strings**: cements the
  default-locale choice into tests; if the team ever flips back or adds
  another supported locale, tests break again. Locale-explicit is the
  durable choice.
* **Why not switch to Key/Semantics finders**: bigger refactor, touches
  production widgets, not warranted for restoring already-shipped tests.
* **Shared helper** if and only if the same locale-wrap pattern appears
  in 3+ test files. The sub-agent should look at the failing tests' shape
  before refactoring — a one-line addition in each `pumpWidget` is fine
  if there's no existing helper.
* **No production code change**: the i18n behaviour as it ships is
  intentional. The tests just need to stop assuming a locale they didn't
  set.

## Requirements

* Restore the 17 failing tests to passing without changing production
  code (no edits under `lib/`, `functions/`).
* All currently-passing tests stay passing.
* The change must NOT depend on the host system's locale list — pinning
  is explicit per `pumpWidget`.

## Acceptance Criteria

* [ ] `flutter test` exits with all currently-listed failures resolved
      (target: `+98 -0` or whatever the new total passing count is
      after the pin).
* [ ] No new failures introduced — the previously-passing 81 tests
      remain green.
* [ ] No edits under `lib/` or `functions/`.
* [ ] `flutter build web` — green (sanity; the change is in tests but
      the web build still must compile cleanly).
* [ ] `flutter analyze` skipped per project memory (CJK-path bug).

## Definition of Done

* AC items pass.
* Single commit on develop.

## Out of Scope

* Refactoring widget structure to add Keys/Semantics for locale-agnostic
  finders.
* Auditing other tests for missing locale pins (only the 17 currently
  failing need touching).
* Changing the app's default locale resolution behaviour.
* Adding locale toggle tests; the existing `regenerate_locale_test.dart`
  is unaffected by this fix.

## Technical Notes

* The required imports are `package:flutter_localizations/flutter_localizations.dart`
  for delegates if any failing test constructs `MaterialApp` directly without
  routing through the production app shell. If the test already uses
  `appRouter` / `RepoShell` etc., those carry the delegates and only the
  `locale:` override needs adding.
* Failures appear under `flutter test` whole-suite for some tests
  (e.g. one task_details case, one stats_view case) that pass when run
  individually. These are order-dependent leaks from earlier-suite tests
  resolving locale fallback differently. Pinning the failing tests' locale
  should also stabilise them — verify by running the whole suite at the
  end.
* Use `const Locale('en')` (not `Locale('en', 'US')`) — the supported
  locales registered by the app likely include `Locale('en')` exactly;
  forcing a country code might fall through to the next supported locale.
