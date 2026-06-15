import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../l10n/app_locale.dart';
import '../repositories/user_repo.dart';

/// Holds the chosen UI language and persists it across launches
/// (SharedPreferences). Defaults to Traditional Chinese; the Settings page lets
/// the user switch to English.
///
/// Once a user is signed in ([attachUser]), the choice is also mirrored to their
/// Firestore user doc (`locale` field) so the backend can localize push
/// notifications per recipient (see functions `tools/i18n.ts`).
class LocaleNotifier with ChangeNotifier {
  LocaleNotifier({UserRepository? userRepository})
      : _userRepository = userRepository ?? UserRepository() {
    _load();
  }

  static const _prefKey = 'ui_locale';

  final UserRepository _userRepository;
  String? _uid;

  AppLocale _locale = AppLocale.zhHant;
  AppLocale get locale => _locale;

  Future<void> _load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final v = prefs.getString(_prefKey);
      if (v != null) {
        _locale = AppLocaleX.fromPref(v);
        notifyListeners();
      }
    } catch (_) {
      // No persistence available (e.g. tests) — keep the default.
    }
  }

  Future<void> setLocale(AppLocale next) async {
    if (_locale == next) return;
    _locale = next;
    notifyListeners();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_prefKey, next.prefValue);
    } catch (_) {
      // Best-effort persistence.
    }
    _syncRemote();
  }

  /// Remember the signed-in user and seed their current language to the backend
  /// so push notifications are localized. Call on sign-in success.
  void attachUser(String uid) {
    _uid = uid;
    _syncRemote();
  }

  /// Forget the user on sign-out so later language changes aren't written for
  /// the wrong account.
  void detachUser() {
    _uid = null;
  }

  /// Best-effort write of the active locale to the user doc. No-op until a user
  /// is attached; failures are swallowed (the UI language is already applied
  /// locally and a stale backend locale only affects push copy).
  Future<void> _syncRemote() async {
    final uid = _uid;
    if (uid == null) return;
    try {
      await _userRepository.updateLocale(uid, _locale.prefValue);
    } catch (_) {
      // Best-effort — don't surface backend write failures to the UI.
    }
  }
}
