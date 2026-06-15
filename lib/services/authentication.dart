import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

import '../config/app_config.dart';
import '../repositories/user_repo.dart';
import 'fake/fake_authentication.dart';

/// Sign-in / sign-out for the app.
///
/// LIVE: Firebase Auth with the GitHub provider. After sign-in we grab the
/// OAuth access token (scopes `repo` + `read:user`) and persist it to
/// `users/{uid}.githubAccessToken`. The live flow is implemented; it only
/// needs the one-time GitHub OAuth App + Firebase Console enablement
/// documented in `docs/SETUP.md §B.4`.
///
/// FAKE: auto-signs in as `DummyData.demoUserId`. Useful while
/// `Authentication → Sign-in method → GitHub` has not been enabled in the
/// Firebase Console yet.
abstract class AuthenticationService {
  factory AuthenticationService() => AppConfig.useFakeBackend
      ? FakeAuthenticationService()
      : _LiveAuthenticationService();

  Stream<bool> authStateChanges();
  String? get currentUid;
  Future<String?> logInWithGitHub();
  Future<void> logOut();
}

class _LiveAuthenticationService implements AuthenticationService {
  _LiveAuthenticationService({UserRepository? userRepository})
      : _userRepository = userRepository ?? UserRepository();

  final FirebaseAuth _firebaseAuth = FirebaseAuth.instance;
  final UserRepository _userRepository;

  @override
  Stream<bool> authStateChanges() =>
      _firebaseAuth.idTokenChanges().map((user) => user != null);

  @override
  String? get currentUid => _firebaseAuth.currentUser?.uid;

  @override
  Future<String?> logInWithGitHub() async {
    final provider = GithubAuthProvider()
      ..addScope('repo')
      ..addScope('read:user');

    // On web, firebase_auth surfaces the provider OAuth access token reliably
    // through the popup flow (`signInWithPopup`); `signInWithProvider` is the
    // mobile/desktop path. Both return a `UserCredential` whose `.credential`
    // is the `OAuthCredential` carrying `accessToken`.
    // NOTE: end-to-end web token retrieval needs a manual e2e run once the
    // GitHub provider is enabled (docs/SETUP.md §B.4).
    final cred = kIsWeb
        ? await _firebaseAuth.signInWithPopup(provider)
        : await _firebaseAuth.signInWithProvider(provider);
    final user = cred.user;
    if (user == null) return null;

    // On Android `signInWithProvider` hands back a base `AuthCredential`
    // (not an `OAuthCredential`), so a hard `as OAuthCredential?` cast throws
    // "type 'AuthCredential' is not a subtype of OAuthCredential?". Guard with
    // `is` so the token is read when present and degrades to null otherwise.
    final credential = cred.credential;
    final accessToken =
        credential is OAuthCredential ? credential.accessToken : null;

    await _userRepository.upsertUserFromAuth(
      userId: user.uid,
      name: user.displayName ?? '',
      email: user.email ?? '',
      avatarUrl: user.photoURL ?? '',
      githubLogin: cred.additionalUserInfo?.username ?? '',
      // TODO(security): encrypt with Cloud KMS before production
      // (ARCHITECTURE.md §6.1).
      githubAccessToken: accessToken,
    );

    return user.uid;
  }

  @override
  Future<void> logOut() async {
    await _firebaseAuth.signOut();
  }
}
