import '../../config/app_config.dart';
import '../../data/dummy_data.dart';
import '../../models/app_user.dart';
import '../user_repo.dart';
import '_replay_state.dart';

class FakeUserRepository implements UserRepository {
  // Singleton — every `UserRepository()` in fake mode returns this same
  // instance so mutations are visible across the app.
  factory FakeUserRepository() => _instance;
  FakeUserRepository._internal();
  static final FakeUserRepository _instance = FakeUserRepository._internal();

  // In-memory user table seeded from DummyData. Mutations reset on app
  // restart — this is a dev fake, not a persistence layer.
  late final Map<String, ReplayState<AppUser?>> _users = {
    for (final u in DummyData.users) u.id: ReplayState<AppUser?>(u),
  };

  @override
  Stream<AppUser?> streamUser(String userId) =>
      _state(userId).stream;

  @override
  Future<AppUser?> getUser(String userId) async {
    await Future.delayed(AppConfig.simulatedLatency);
    return _users[userId]?.value;
  }

  @override
  Future<void> upsertUserFromAuth({
    required String userId,
    required String name,
    required String email,
    required String avatarUrl,
    required String githubLogin,
    String? githubAccessToken,
  }) async {
    await Future.delayed(AppConfig.simulatedLatency);
    final existing = _users[userId]?.value;
    final next = AppUser(
      id: userId,
      name: name.isNotEmpty ? name : existing?.name ?? 'Unknown',
      email: email,
      avatarUrl: avatarUrl,
      githubLogin: githubLogin,
      githubAccessToken: githubAccessToken,
      discordUserId: existing?.discordUserId,
      fcmToken: existing?.fcmToken,
      locale: existing?.locale,
      expertiseTags: existing?.expertiseTags ?? const [],
    );
    _state(userId).update(next);
  }

  @override
  Future<void> updateFcmToken(String userId, String token) async {
    await Future.delayed(AppConfig.simulatedLatency);
    final existing = _users[userId]?.value;
    if (existing == null) return;
    final next = AppUser(
      id: existing.id,
      name: existing.name,
      email: existing.email,
      avatarUrl: existing.avatarUrl,
      githubLogin: existing.githubLogin,
      githubAccessToken: existing.githubAccessToken,
      discordUserId: existing.discordUserId,
      fcmToken: token,
      locale: existing.locale,
      expertiseTags: existing.expertiseTags,
    );
    _state(userId).update(next);
  }

  @override
  Future<void> updateDiscordUserId(
      String userId, String discordUserId) async {
    await Future.delayed(AppConfig.simulatedLatency);
    final existing = _users[userId]?.value;
    if (existing == null) return;
    final next = AppUser(
      id: existing.id,
      name: existing.name,
      email: existing.email,
      avatarUrl: existing.avatarUrl,
      githubLogin: existing.githubLogin,
      githubAccessToken: existing.githubAccessToken,
      discordUserId: discordUserId,
      fcmToken: existing.fcmToken,
      locale: existing.locale,
      expertiseTags: existing.expertiseTags,
    );
    _state(userId).update(next);
  }

  @override
  Future<void> updateLocale(String userId, String locale) async {
    await Future.delayed(AppConfig.simulatedLatency);
    final existing = _users[userId]?.value;
    if (existing == null) return;
    final next = AppUser(
      id: existing.id,
      name: existing.name,
      email: existing.email,
      avatarUrl: existing.avatarUrl,
      githubLogin: existing.githubLogin,
      githubAccessToken: existing.githubAccessToken,
      discordUserId: existing.discordUserId,
      fcmToken: existing.fcmToken,
      locale: locale,
      expertiseTags: existing.expertiseTags,
    );
    _state(userId).update(next);
  }

  ReplayState<AppUser?> _state(String userId) =>
      _users.putIfAbsent(userId, () => ReplayState<AppUser?>(null));
}
