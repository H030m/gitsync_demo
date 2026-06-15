import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:gitsync/services/authentication.dart';
import 'package:gitsync/view_models/auth_vm.dart';

/// Hand-rolled fake (no mockito/mocktail). Lets each test drive the outcome of
/// `logInWithGitHub` and observe re-entrancy via a completer.
class _FakeAuthenticationService implements AuthenticationService {
  _FakeAuthenticationService({
    this.uidToReturn,
    this.errorToThrow,
    this.gate,
  });

  /// Returned by `logInWithGitHub` (a null uid means "no user").
  final String? uidToReturn;

  /// If set, `logInWithGitHub` throws this instead of returning.
  final Object? errorToThrow;

  /// If set, `logInWithGitHub` awaits this before completing — lets a test
  /// hold the first call open to probe the re-entrancy guard.
  final Future<void>? gate;

  int logInCalls = 0;
  bool _signedIn = false;

  @override
  Stream<bool> authStateChanges() => Stream<bool>.value(_signedIn);

  @override
  String? get currentUid => _signedIn ? uidToReturn : null;

  @override
  Future<String?> logInWithGitHub() async {
    logInCalls++;
    if (gate != null) await gate;
    if (errorToThrow != null) throw errorToThrow!;
    _signedIn = uidToReturn != null;
    return uidToReturn;
  }

  @override
  Future<void> logOut() async {
    _signedIn = false;
  }
}

void main() {
  group('AuthViewModel.signInWithGitHub', () {
    test('returns true and clears lastError on success', () async {
      final auth = _FakeAuthenticationService(uidToReturn: 'uid-123');
      final vm = AuthViewModel(authService: auth);

      final ok = await vm.signInWithGitHub();

      expect(ok, isTrue);
      expect(vm.lastError, isNull);
      expect(vm.isSigningIn, isFalse);
      expect(auth.logInCalls, 1);
    });

    test('returns false when no user comes back', () async {
      final auth = _FakeAuthenticationService(uidToReturn: null);
      final vm = AuthViewModel(authService: auth);

      final ok = await vm.signInWithGitHub();

      expect(ok, isFalse);
      expect(vm.lastError, isNull);
    });

    test('sets lastError and returns false on exception', () async {
      final auth =
          _FakeAuthenticationService(errorToThrow: Exception('boom'));
      final vm = AuthViewModel(authService: auth);

      final ok = await vm.signInWithGitHub();

      expect(ok, isFalse);
      expect(vm.lastError, contains('boom'));
      expect(vm.isSigningIn, isFalse);
    });

    test('re-entrancy guard: second call while signing in is a no-op', () async {
      final gate = Completer<void>();
      final auth =
          _FakeAuthenticationService(uidToReturn: 'uid-123', gate: gate.future);
      final vm = AuthViewModel(authService: auth);

      // Start the first sign-in but do not await it — it parks on the gate.
      final first = vm.signInWithGitHub();
      expect(vm.isSigningIn, isTrue);

      // Second call must bail out immediately without invoking the service.
      final second = await vm.signInWithGitHub();
      expect(second, isFalse);
      expect(auth.logInCalls, 1);

      gate.complete();
      expect(await first, isTrue);
      expect(auth.logInCalls, 1);
    });
  });
}
