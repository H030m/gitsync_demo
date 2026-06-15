// PLACEHOLDER / template — copy this file to `lib/firebase_options.dart` after
// cloning the repo so the app compiles. Two ways forward:
//
//   1. **Fake backend mode (default)** — keep this placeholder as-is. The app
//      runs against in-memory dummy data and never calls Firebase.
//      Setup: `Copy-Item lib/firebase_options.example.dart lib/firebase_options.dart`
//
//   2. **Live backend mode** — run `flutterfire configure` after copying.
//      It will overwrite `lib/firebase_options.dart` with your real Firebase
//      project's apiKey / appId / etc. Those values are local-only because
//      `lib/firebase_options.dart` is gitignored.
//
// Why this song-and-dance: the real config file contains the Firebase web
// apiKey. Although Firebase docs say it is restricted by Security Rules +
// Authorized Domains and is technically OK to commit, this project's
// owner prefers it stays out of git. See `.gitignore` + `secrets/README.md`.
import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;

class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    throw UnsupportedError(
      'firebase_options.dart is still the placeholder. Either run '
      '`flutterfire configure`, or stay in fake-backend mode '
      '(AppConfig.useFakeBackend == true) so this is never called.',
    );
  }
}
