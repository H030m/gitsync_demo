# fix(vm): guard StatsViewModel notifyListeners against post-dispose async callbacks

## Goal

Stop the runtime exception thrown when leaving the Stats tab while
its in-flight Firestore fetch or per-user `getUser` lookup is still
pending:

> A StatsViewModel was used after being disposed. Once you have called
> dispose() on a StatsViewModel, it can no longer be used.

## Root cause (diagnosed 2026-06-14)

`lib/view_models/stats_vm.dart` has two `notifyListeners()` calls that
fire after async work without checking whether the VM is still alive:

* **Line 149** — `_loadAllCommits()` does
  `await _commitRepo.fetchAllCommits(_repoId)` and then notifies in
  `finally`. If the user navigates away during the await, the local
  `ChangeNotifierProvider` disposes the VM, and the `finally` block
  hits `debugAssertNotDisposed` in `notifyListeners`.
* **Line 175** — `_resolveNames(members)` fires per-uid
  `_userRepo.getUser(uid).then(...).whenComplete(...)`. The
  `whenComplete` callback calls `notifyListeners()` too. Same window.

The bug has always been there in code; it surfaced reliably only after
task `06-13-replace-shell-page-swap-with-customtransitionpage-at-gorouter-level`
made each shell tab its own `Page` in the Navigator stack, so leaving
the Stats tab now cleanly unmounts its widget tree → disposes the
locally-scoped `StatsViewModel` → in-flight callbacks reliably hit a
disposed notifier during the 300 ms slide.

The fix is in the VM, not in the routing layer. The same defensive
pattern is missing across other VMs too — see Out of Scope below.

## Decisions (locked 2026-06-14)

* Defensive `_disposed` flag pattern (the conventional Flutter idiom):
  * Add `bool _disposed = false;` private field.
  * Override `dispose()` so it sets `_disposed = true` **before**
    `super.dispose()`.
  * Replace every `notifyListeners()` in the file with a private
    `_safeNotify()` helper that early-returns when `_disposed`.
* `_safeNotify()` is private to the file and used at every notify
  site, not just the two async sites — uniform call shape avoids the
  next contributor accidentally introducing a third unguarded site.
* No `mounted`-style getters and no third-party micro-package. The
  `_disposed` field is the minimal addition.
* Audit other view-models for the same pattern — **out of scope**, see
  Out of Scope below.

## Requirements

* Single file: `lib/view_models/stats_vm.dart`.
* Add the `_disposed` field, override `dispose()`, add `_safeNotify()`.
* Swap every `notifyListeners()` callsite in this file to `_safeNotify()`.
* No other file touched. No tests added (race-on-dispose is not
  practically unit-testable without elaborate fakes; the change is so
  small the visual-smoke test is the truth signal).

## Acceptance Criteria

* [ ] Open the app on Chrome / Path B → navigate to Stats → switch
      tabs immediately. Console no longer prints `A StatsViewModel was
      used after being disposed.`
* [ ] Existing widget tests still pass (`flutter test` matches the same
      baseline as before — currently 81 passing + 17 pre-existing
      failures unrelated to this VM).
* [ ] `flutter build web` — green.
* [ ] `flutter analyze` skipped per project memory (CJK-path bug).

## Definition of Done

* AC items pass.
* Single commit on develop.

## Out of Scope

* Auditing other view-models (`TasksBoardViewModel`,
  `MembersViewModel`, `CommitsViewModel`, `DiscordChatViewModel`,
  `DailyReportViewModel`, etc.) for the same post-dispose pattern.
  They almost certainly have it; the right follow-up is a separate
  sweep task that adds a shared `SafeNotifierMixin` if the pattern
  appears in three or more VMs.
* Reverting the route-level shell-tab transition. The route change
  exposed the latent bug; the bug is in the VM and the routing layer
  is correct.
* Cancelling in-flight Firestore subscriptions / Futures on dispose.
  The fetches here are one-shot Futures, not streams, so cancellation
  doesn't apply directly; the dispose guard is sufficient.

## Technical Notes

* `super.dispose()` runs `_disposed = true` semantics internally too
  (via `debugAssertNotDisposed`), but reading that private state from
  subclasses isn't supported. The explicit `_disposed` field is the
  idiomatic Flutter workaround for this exact symptom and appears in
  many Flutter sample codebases.
* Setting `_disposed = true` BEFORE `super.dispose()` is important:
  a callback that fires *during* `super.dispose()` (rare, but
  possible if a listener removes itself synchronously) sees the
  guard.
* The change is tiny enough that no separate widget test is
  warranted. If we ever build a `SafeNotifierMixin` (see Out of Scope),
  it should ship with a unit test for `_safeNotify` once-after-dispose.
