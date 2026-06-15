import 'dart:async';

import '../../data/dummy_data.dart';
import '../../models/discord_digest.dart';
import '../discord_digest_repo.dart';
import '_replay_state.dart';

/// Fake digest repo. Starts empty (no digest) and only emits once
/// [emitDemoDigest] is called — which the fake `requestDiscordFetch` does to
/// mimic the real backend writing a `discordDigests/{date}` doc after a
/// refresh. This keeps the refresh button meaningful in fake mode.
class FakeDiscordDigestRepository implements DiscordDigestRepository {
  factory FakeDiscordDigestRepository() => _instance;
  FakeDiscordDigestRepository._internal();
  static final FakeDiscordDigestRepository _instance =
      FakeDiscordDigestRepository._internal();

  // Keyed by "repoId|date" so each day has its own replayable state.
  final Map<String, ReplayState<DiscordDigest?>> _byKey = {};

  // Per-repo "something changed" broadcaster, so range subscriptions can
  // recompute their window whenever any day's digest is written/edited.
  final Map<String, StreamController<void>> _ticks = {};

  String _key(String repoId, String date) => '$repoId|$date';

  ReplayState<DiscordDigest?> _state(String repoId, String date) => _byKey
      .putIfAbsent(_key(repoId, date), () => ReplayState<DiscordDigest?>(null));

  StreamController<void> _tick(String repoId) =>
      _ticks.putIfAbsent(repoId, () => StreamController<void>.broadcast());

  // The digests currently held for [repoId] whose date is within
  // [startKey]..[endKey] inclusive, newest-first.
  List<DiscordDigest> _snapshot(String repoId, String startKey, String endKey) {
    final out = <DiscordDigest>[];
    final prefix = '$repoId|';
    for (final entry in _byKey.entries) {
      if (!entry.key.startsWith(prefix)) continue;
      final digest = entry.value.value;
      if (digest == null) continue;
      if (digest.date.compareTo(startKey) < 0) continue;
      if (digest.date.compareTo(endKey) > 0) continue;
      out.add(digest);
    }
    out.sort((a, b) => b.date.compareTo(a.date));
    return out;
  }

  @override
  Stream<DiscordDigest?> streamDigest(String repoId, String date) =>
      _state(repoId, date).stream;

  @override
  Stream<List<DiscordDigest>> streamDigestsInRange(
    String repoId,
    String startKey,
    String endKey,
  ) async* {
    yield _snapshot(repoId, startKey, endKey);
    yield* _tick(repoId)
        .stream
        .map((_) => _snapshot(repoId, startKey, endKey));
  }

  /// Simulates the backend producing a digest for [date] (called by the fake
  /// FunctionsService after a refresh request settles).
  void emitDemoDigest(String repoId, String date) {
    _state(repoId, date).update(
      DiscordDigest(
        date: date,
        markdown: DummyData.discordDigestMarkdown,
        messageCount: DummyData.discordMessages.length,
      ),
    );
    _tick(repoId).add(null);
  }

  /// Test seam: seeds an explicit digest for [date] (used by widget tests that
  /// need a multi-day window). Mirrors a backend-written `discordDigests/{date}`
  /// doc but lets the caller control the markdown.
  void seedDigest(String repoId, DiscordDigest digest) {
    _state(repoId, digest.date).update(digest);
    _tick(repoId).add(null);
  }

  /// Test seam: clears every held digest (and the per-repo tick), so tests that
  /// reuse the singleton fake start from a clean slate.
  void reset() {
    _byKey.clear();
    for (final c in _ticks.values) {
      c.close();
    }
    _ticks.clear();
  }

  /// Mutates the current digest for [date] in fake mode (used by the fake
  /// FunctionsService for AI edits / lock toggles). No-ops if there's no digest
  /// yet. Respects the lock for [markdown] edits.
  void applyEdit(
    String repoId,
    String date, {
    String? markdown,
    bool? locked,
  }) {
    final current = _state(repoId, date).value;
    if (current == null) return;
    if (markdown != null && current.locked) return; // frozen
    _state(repoId, date).update(
      DiscordDigest(
        date: current.date,
        markdown: markdown ?? current.markdown,
        messageCount: current.messageCount,
        locked: locked ?? current.locked,
        generatedAt: current.generatedAt,
      ),
    );
    _tick(repoId).add(null);
  }
}
