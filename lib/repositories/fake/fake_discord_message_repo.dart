import '../../data/dummy_data.dart';
import '../../models/discord_message.dart';
import '../discord_message_repo.dart';
import '_replay_state.dart';

class FakeDiscordMessageRepository implements DiscordMessageRepository {
  factory FakeDiscordMessageRepository() => _instance;
  FakeDiscordMessageRepository._internal();
  static final FakeDiscordMessageRepository _instance =
      FakeDiscordMessageRepository._internal();

  late final Map<String, ReplayState<List<DiscordMessage>>> _byRepo = {
    DummyData.demoRepoId:
        ReplayState<List<DiscordMessage>>(DummyData.discordMessages),
  };

  ReplayState<List<DiscordMessage>> _state(String repoId) => _byRepo
      .putIfAbsent(repoId, () => ReplayState<List<DiscordMessage>>(const []));

  @override
  Stream<List<DiscordMessage>> streamRecent(String repoId,
      {int limit = 100}) async* {
    yield _state(repoId).value.take(limit).toList();
    await for (final list in _state(repoId).stream) {
      yield list.take(limit).toList();
    }
  }
}
