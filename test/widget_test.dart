// Placeholder smoke test. The skeleton's root widget needs Firebase to be
// initialized before mounting, which the default `flutter test` harness does
// not do — so we only assert that the entry-point file imports cleanly.
//
// Replace this with feature-specific tests as views/view-models get filled in.
import 'package:flutter_test/flutter_test.dart';

import 'package:gitsync/main.dart';

void main() {
  test('GitSyncApp is importable', () {
    // ignore: unnecessary_type_check
    expect(GitSyncApp, isNotNull);
  });
}
