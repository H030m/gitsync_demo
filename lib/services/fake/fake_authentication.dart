import '../../config/app_config.dart';
import '../../data/dummy_data.dart';
import '../authentication.dart';

/// Fake auth that auto-signs-in as the demo user. No network, no Firebase.
class FakeAuthenticationService implements AuthenticationService {
  factory FakeAuthenticationService() => _instance;
  FakeAuthenticationService._internal();
  static final FakeAuthenticationService _instance =
      FakeAuthenticationService._internal();

  bool _signedIn = AppConfig.autoSignInDemoUser;

  @override
  Stream<bool> authStateChanges() => Stream<bool>.value(_signedIn);

  @override
  String? get currentUid => _signedIn ? DummyData.demoUserId : null;

  @override
  Future<String?> logInWithGitHub() async {
    await Future.delayed(AppConfig.simulatedLatency);
    _signedIn = true;
    return DummyData.demoUserId;
  }

  @override
  Future<void> logOut() async {
    await Future.delayed(AppConfig.simulatedLatency);
    _signedIn = false;
  }
}
