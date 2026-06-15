# fix(fcm-web): add firebase-messaging-sw.js and wire vapidKey for web FCM

## Goal

Eliminate the recurring console error:

> [firebase_messaging/failed-service-worker-registration] Messaging:
> We are unable to register the default service worker.
> Failed to register a ServiceWorker for scope … :
> The script has an unsupported MIME type ('text/html').

…and complete the web side of FCM so the existing
`PushMessagingService.initialize()` (already wired in by
`74131b1 feat(notifications): show foreground notifications + settings
test action`) can actually obtain a token on Chrome.

## Root cause (diagnosed 2026-06-14)

Two missing pieces on web that the original FCM task
(`06-03-wire-fcm-notifications`, now archived) called out as Web
prerequisites:

1. **`web/firebase-messaging-sw.js` does not exist.** Flutter web's
   dev server falls back to serving `index.html` for unknown paths, so
   the browser tries to register a service worker whose script is
   `text/html` instead of JavaScript → registration fails.
2. **`getToken()` is called without `vapidKey:` on web.**
   `lib/services/push_messaging.dart:70` calls `_fcm.getToken()`
   unconditionally. On web this requires the Firebase project's VAPID
   public key (from Firebase Console → Cloud Messaging → Web Push
   certificates). Without it, even with the SW present, token fetch
   throws.

Fixing (1) alone clears the reported error. Fixing (1)+(2) makes web
FCM actually work end-to-end once the user supplies the key.

## Decisions (locked 2026-06-14)

* **Create `web/firebase-messaging-sw.js`** with the Firebase web
  compat scripts and the project's web config. The config (`apiKey`,
  `appId`, `messagingSenderId`, `projectId`, `authDomain`,
  `storageBucket`) is mirrored from `lib/firebase_options.dart` —
  these are public client-side credentials. Use Firebase JS SDK
  v10.x via the CDN-hosted `*-compat.js` files. The SW does:
  1. `importScripts(…firebase-app-compat.js)` and
     `firebase-messaging-compat.js`.
  2. `firebase.initializeApp({…})` with the web config.
  3. `firebase.messaging()` to wire the background listener.

  No custom `onBackgroundMessage` payload formatting; the default
  Firebase SW behavior (show the notification's title/body) is
  sufficient for MVP. Foreground notifications stay handled by the
  existing `LocalNotificationsService` in
  `push_messaging.dart`.

* **VAPID key plumbing**: read from a compile-time
  `--dart-define=FCM_VAPID_KEY=...`, exposed as
  `AppConfig.fcmVapidKey` (mirrors the existing `BACKEND` / `TARGET`
  pattern in `lib/config/app_config.dart`). On web only:
  - If the key is non-empty: pass it to `_fcm.getToken(vapidKey: …)`.
  - If the key is empty: log a single clear warning via
    `debugPrint('[FCM web] FCM_VAPID_KEY not set — token fetch skipped.
    See docs/SETUP.md to obtain one.')` and skip token write. Don't
    throw. App keeps running.

  On non-web, behavior is unchanged (`getToken()` with no args).

* **Document the user setup**: append a `Firebase Cloud Messaging (web)`
  subsection to `docs/SETUP.md` (or `README.md` — whichever holds the
  Path B recipe). Steps:
  1. Firebase Console → Project Settings → Cloud Messaging tab →
     Web configuration → Web Push certificates → Generate key pair.
  2. Copy the public key.
  3. Add to the run command:
     `flutter run -d chrome --dart-define=BACKEND=live --dart-define=FCM_VAPID_KEY=<paste>`.
  4. Notifications now work on Chrome.

* **No FCM behavior change on mobile** — the existing Android/iOS
  paths use `getToken()` without a vapidKey, as is correct.

* **NOT in scope**: bot-side / backend sender changes; the existing
  `tools/notify.ts notifyAssignee` is already wired and will fire as
  soon as `users/{uid}.fcmToken` populates.

## Requirements

* New file: `web/firebase-messaging-sw.js`. Self-contained, no build
  step.
* Edit `lib/config/app_config.dart` to expose
  `static String get fcmVapidKey =>
  const String.fromEnvironment('FCM_VAPID_KEY', defaultValue: '');`
  in the same style as the existing `BACKEND` / `TARGET` getters.
* Edit `lib/services/push_messaging.dart` to use `kIsWeb` from
  `package:flutter/foundation.dart` and call
  `_fcm.getToken(vapidKey: AppConfig.fcmVapidKey)` on web (or skip
  with a warning when the key is empty). Non-web path is unchanged.
* Edit `docs/SETUP.md` (or README) — add the FCM-web subsection.
* No edits under `functions/`.
* No new pubspec entries.

## Acceptance Criteria

* [ ] On Chrome / Path B, the `firebase_messaging/failed-service-worker-registration`
      error no longer appears in the console at startup.
* [ ] With `--dart-define=FCM_VAPID_KEY=<key>` set, `users/{uid}.fcmToken`
      gets populated in Firestore on first sign-in (verifiable in
      Firebase console). Without the key, the app still launches
      cleanly with a single one-line warning in the console.
* [ ] `flutter test` — `+98 -0` (baseline unchanged).
* [ ] `flutter build web` — green.
* [ ] No mobile-side regressions.

## Definition of Done

* AC items pass.
* `flutter analyze` skipped (CJK-path tooling bug per project memory).
* Single commit on develop.

## Out of Scope

* Customising the background notification UI (icon, click action).
  The default Firebase SW behavior is fine for MVP.
* Adding tests around the SW or `getToken` web path — both depend on
  browser primitives that aren't unit-testable without elaborate
  shims.
* Migrating any stored documents.
* Implementing the alternate "in-app Firestore listener on
  `assigneeId == me`" path that the original 06-03 PRD mentioned;
  the foreground assignment banner already covers that surface per
  the existing `push_messaging.dart` comment.

## Technical Notes

* The `firebase-messaging-sw.js` must be at the root of `web/` so
  it's served at `/firebase-messaging-sw.js` (which is the default
  scope the Firebase JS SDK registers).
* The Firebase compat scripts (`firebase-app-compat.js`,
  `firebase-messaging-compat.js`) are hosted at
  `https://www.gstatic.com/firebasejs/<version>/...`. Pin to the
  same major as `firebase_messaging` in `pubspec.yaml`'s lock.
* VAPID keys are PUBLIC keys (named "Web Push certificate public
  key" in the console). Safe to commit if the user prefers, but the
  `--dart-define` plumbing keeps secrets out of git regardless.
* `kIsWeb` is the conventional cross-platform check; importing
  `dart:html` directly would break compilation on mobile.
