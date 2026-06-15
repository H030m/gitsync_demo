import 'package:flutter/foundation.dart';

import '../data/mock_store.dart';
import '../models/app_user.dart';

/// Handles sign-up / login / logout and exposes the current user.
///
/// Passwords are not verified in this demo store — sign-up creates an account
/// and login resolves an existing one by email.
class AuthService extends ChangeNotifier {
  AuthService(this._store);

  final MockStore _store;

  AppUser? _current;
  AppUser? get current => _current;
  bool get isLoggedIn => _current != null;

  /// Create a new account, then sign in. Throws if the email is taken.
  AppUser signUp({required String name, required String email}) {
    if (_store.findUserByEmail(email) != null) {
      throw StateError('此 Email 已經註冊過');
    }
    final user = _store.addUser(
      AppUser(id: 'u${email.hashCode}', name: name, email: email),
    );
    _current = user;
    notifyListeners();
    return user;
  }

  /// Sign in an existing account by email. Throws if not found.
  AppUser login({required String email}) {
    final user = _store.findUserByEmail(email);
    if (user == null) {
      throw StateError('找不到帳號，請先註冊');
    }
    _current = user;
    notifyListeners();
    return user;
  }

  void logout() {
    _current = null;
    notifyListeners();
  }
}

// signUp / login / logout 完整實作，含目前使用者狀態保存。

// signUp / login / logout 完整實作，含目前使用者狀態保存。

// signUp / login / logout 完整實作，含目前使用者狀態保存。

// signUp / login / logout 完整實作，含目前使用者狀態保存。
