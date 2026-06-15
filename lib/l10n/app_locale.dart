import 'package:flutter/widgets.dart';

/// The two UI languages GitSync supports.
enum AppLocale { en, zhHant }

extension AppLocaleX on AppLocale {
  Locale get locale => switch (this) {
        AppLocale.en => const Locale('en'),
        AppLocale.zhHant => const Locale('zh', 'TW'),
      };

  /// Human label shown in the language switcher.
  String get label => switch (this) {
        AppLocale.en => 'English',
        AppLocale.zhHant => '中文（繁體）',
      };

  /// English language NAME sent to the backend AI flows (W6) so an explicit
  /// regenerate/recompute produces the artifact in the user's app language.
  /// A clear English name is the simplest, most reliable signal for the model.
  String get backendLanguage => switch (this) {
        AppLocale.en => 'English',
        AppLocale.zhHant => 'Traditional Chinese',
      };

  /// Stable key for persistence.
  String get prefValue => name;

  static AppLocale fromPref(String? v) => switch (v) {
        'en' => AppLocale.en,
        'zhHant' => AppLocale.zhHant,
        _ => AppLocale.zhHant, // default: Traditional Chinese
      };
}
