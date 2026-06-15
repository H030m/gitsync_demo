import '../../config/app_config.dart';
import '../discord_fetch_repo.dart';

/// Fake fetch-request status stream. Emits `'pending'` immediately, then
/// `'done'` after a short delay so fake mode demonstrates the full
/// request → bot round-trip → "Updated" flow.
class FakeDiscordFetchRepository implements DiscordFetchRepository {
  @override
  Stream<String?> streamStatus(String repoId, String requestId) async* {
    yield 'pending';
    await Future.delayed(AppConfig.simulatedLatency * 4);
    yield 'done';
  }
}
