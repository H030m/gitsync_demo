# Quality Guidelines (Flutter)

> The binding rules are in [`docs/AI_AGENT_RULES.md`](../../../docs/AI_AGENT_RULES.md) (esp. §3–§4).
> This is the frontend-specific checklist.

---

## Required patterns

- MVVM 5-layer boundaries hold (View → ViewModel → Repository → Firestore).
- `Consumer<VM>` in `build()`; `Provider.of<VM>(ctx, listen:false)` in callbacks.
- Navigation via `NavigationService`, never raw `context.go` / `Navigator.push`.
- `if (mounted)` before every post-`await` `BuildContext` use.
- Every `StreamSubscription` cancelled in `dispose()`.
- Repository writes carry `.timeout(const Duration(seconds: 10))`.
- Colors/text via `Theme.of(ctx).colorScheme` / `.textTheme` — no hardcoded colors.
- New repository/service methods are added to the Fake implementation too.
- **Upsert preserves `createdAt`**: an "upsert from auth/login" write must only stamp
  `createdAt: FieldValue.serverTimestamp()` when the doc does not yet exist — otherwise a
  returning user's `createdAt` is reset on every login. Use `runTransaction` (read → set only
  the new fields, conditionally include `createdAt` on `!snap.exists`) rather than an
  unconditional `set(..., merge:true)`. (Fixed in `user_repo.upsertUserFromAuth`,
  task `06-02-github-oauth`.)

---

## Forbidden

- `print()` left in code; commented-out code; stray `TODO:` / `FIXME:` (unless asked).
- View importing `cloud_firestore` or `repositories/*`.
- ViewModel importing `material.dart` or holding `BuildContext`.
- New dependencies without asking. Specifically banned (course stack):
  **Riverpod / Bloc / GetX** (use `provider`), **auto_route** (use `go_router`),
  **dio** (use `cloud_functions` callables), **freezed / json_serializable** (hand-write maps).
  Allowed when no built-in fits: `fl_chart` / `graphic` for charts (ask first).
- Over-engineering: no abstractions "for the future", no wrappers for one-time <10-line logic.

---

## 🚫 The AI never runs these (user does — `AI_AGENT_RULES.md §R1/§R2/§R3`)

- `git commit` / `git push` / any history-writing git.
- `flutter pub add` / editing `pubspec.yaml` deps without asking.
- `firebase deploy`. Dev uses fake mode or `firebase emulators:start`.

---

## Verify before saying "done" (`AI_AGENT_RULES.md §4`)

- `flutter analyze` → 0 error / 0 warning (run it — the one info `use_null_aware_elements` is expected).
  - **Gotcha — non-ASCII repo path**: if the clone's absolute path contains non-ASCII
    characters (e.g. CJK like `大二下/軟體實驗設計`), `flutter analyze` crashes with
    `Unhandled exception: FormatException: Unterminated string` (the analysis server mis-parses
    the URL-encoded workspace URI). This is a tooling bug, not a code issue. Either clone to an
    ASCII-only path, or use **`flutter build web --no-pub`** (or a clean `flutter run`) as the
    compile gate instead. The IDE analyzer is unaffected.
- Ran the golden path in fake mode (`flutter run`, default `BACKEND=fake`).
  - **Gotcha — Android build needs `google-services.json` even in fake mode**: the file is
    gitignored and the repo ships **no template**, so a fresh clone fails the Gradle task
    `:app:processDebugGoogleServices` when targeting an Android device/emulator. Either run
    `flutterfire configure --project=gitsync-645b3` (real config), or drop a placeholder at
    `android/app/google-services.json` (`project_id: gitsync-645b3`,
    `package_name: com.example.gitsync`, dummy number/app-id/api-key) — fake mode never reads
    its values at runtime, it only has to satisfy the Google Services Gradle plugin.
    (Web/Chrome targets don't need it.) See `docs/SETUP.md §5.10`.
- Report with the 5-field format: ✅做了 / 📁動了 / ⚠️沒做 / 🧪驗證 / 💬建議 commit message
  (English, imperative; AI generates the string only, never runs `git commit`).
- Wrote a journal entry under `docs/journal/<you>.md` and updated `_index.md`. See the
  [shared quality bar](../guides/index.md).

## Testing

Minimum bar: `flutter analyze` clean + manual golden-path run in fake mode. State clearly what
was not verified (e.g. Android, live Firestore, live OAuth).

**ViewModel unit tests** (pattern established in `test/auth_vm_test.dart`, task `06-02-github-oauth`):
test a VM by injecting a **hand-rolled fake** of its service/repository — the same
fake-implementation pattern used in `lib/repositories/fake/`. Do **not** add `mockito` / `mocktail`
(no new deps). Cover the VM's state transitions (success, failure→`lastError`, re-entrancy guard).
Run with `flutter test`.

> **Gotcha — federated sign-in on web**: `firebase_auth` GitHub login must branch on `kIsWeb`
> (`package:flutter/foundation.dart`): use `signInWithPopup(provider)` on web,
> `signInWithProvider(provider)` on mobile/desktop. Both yield a `UserCredential` whose
> `.credential as OAuthCredential?` carries `.accessToken`. Live web token retrieval can only be
> confirmed by a manual e2e run once the provider is enabled in the Firebase Console.
