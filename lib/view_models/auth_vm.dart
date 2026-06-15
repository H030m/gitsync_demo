import 'package:flutter/foundation.dart';

import '../services/authentication.dart';

class AuthViewModel with ChangeNotifier {
  AuthViewModel({AuthenticationService? authService})
      : _auth = authService ?? AuthenticationService();

  final AuthenticationService _auth;

  bool _isSigningIn = false;
  bool get isSigningIn => _isSigningIn;

  String? _lastError;
  String? get lastError => _lastError;

  String? get currentUid => _auth.currentUid;

  Future<bool> signInWithGitHub() async {
    if (_isSigningIn) return false;
    _isSigningIn = true;
    _lastError = null;
    notifyListeners();
    try {
      final uid = await _auth.logInWithGitHub();
      return uid != null;
    } catch (e) {
      _lastError = e.toString();
      return false;
    } finally {
      _isSigningIn = false;
      notifyListeners();
    }
  }

  Future<void> signOut() async {
    await _auth.logOut();
    notifyListeners();
  }
}
