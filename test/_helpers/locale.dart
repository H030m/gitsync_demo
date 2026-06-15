import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';

import 'package:gitsync/l10n/app_locale.dart';
import 'package:gitsync/services/locale_notifier.dart';

/// Test-only [LocaleNotifier] subclass that pins the UI language to whatever
/// the test asks for. Production [LocaleNotifier] defaults to Traditional
/// Chinese and consults `SharedPreferences` on construction; widget tests that
/// inspect English (or zh) UI strings want a deterministic locale instead.
///
/// Wrap the widget under test with [pinLocale] so the production
/// `context.l10n` extension — which reads `LocaleNotifier` via Provider —
/// returns strings in the pinned language.
class _PinnedLocaleNotifier extends LocaleNotifier {
  _PinnedLocaleNotifier(this._pinned);
  final AppLocale _pinned;

  @override
  AppLocale get locale => _pinned;
}

/// Wraps [child] in a `ChangeNotifierProvider<LocaleNotifier>` pinned to
/// [locale]. Use inside `MaterialApp(home: pinLocale(AppLocale.en, child: ...))`
/// or as a `MultiProvider` child so the test tree resolves `context.l10n` to a
/// known language regardless of the host system locale.
Widget pinLocale(AppLocale locale, {required Widget child}) {
  return ChangeNotifierProvider<LocaleNotifier>(
    create: (_) => _PinnedLocaleNotifier(locale),
    child: child,
  );
}
