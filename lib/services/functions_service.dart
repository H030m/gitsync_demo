import 'package:cloud_functions/cloud_functions.dart';

import '../config/app_config.dart';
import '../models/ask_repo.dart';
import '../models/commit_graph.dart';
import '../models/daily_brief.dart';
import '../models/discord_chat.dart';
import '../models/sub_task.dart';
import 'fake/fake_functions_service.dart';

/// Single entry point for every Cloud Functions callable.
///
/// LIVE: hits the real Cloud Functions in `asia-east1`. Region must match
/// `functions/src/admin.ts::REGION`.
/// (See MEMORY.md 2026-05-27 "region locked to asia-east1".)
///
/// FAKE: returns canned data after a short delay. Useful while OpenAI /
/// GitHub / Discord secrets are not provisioned yet. The AI flow
/// implementations live in `functions/src/flows/*.ts` — once those are
/// done, flip `AppConfig.defaultBackend` to `Backend.live` and the same
/// API surface will hit real OpenAI.
///
/// TODO(handoff to D module — AI Agent owner):
/// real callable bodies are still `throw new Error('not implemented yet')`
/// stubs in `functions/src/flows/*.ts`. Until those are implemented,
/// `Backend.live` mode will surface those stub errors to the UI.
abstract class FunctionsService {
  factory FunctionsService() => AppConfig.useFakeBackend
      ? FakeFunctionsService()
      : _LiveFunctionsService();

  // ---- Repo management ---------------------------------------------------

  Future<String> addRepo({required String githubUrl});
  Future<void> removeRepo({required String repoId});

  /// Imports the repo's GitHub collaborators as members (those who already have
  /// a GitSync account). Returns counts + the logins that haven't signed in yet
  /// (`pending`, can't be added as members).
  Future<({int added, int alreadyMembers, List<String> pending})>
      importCollaborators({required String repoId});

  // ---- AI flows ----------------------------------------------------------

  /// Breaks [goal] (typically a pasted SPEC.md) into a task list. [language] is
  /// an English language NAME (e.g. "Traditional Chinese") derived from the app
  /// locale so the generated tasks come back in the user's language (W6); omit
  /// it to let the backend follow the spec's own language.
  Future<List<SubTask>> breakdownTask({
    required String repoId,
    required String goal,
    String? language,
  });
  Future<void> forceUnlockBreakdown({required String repoId});

  /// Deletes EVERY task in [repoId] (resets the board, e.g. before a demo).
  /// Returns how many were removed.
  Future<int> deleteAllTasks({required String repoId});
  Future<({String assigneeId, String reasoning})> assignTask({
    required String repoId,
    required String taskId,
  });
  /// Regenerates the AI handoff doc for [taskId] (force=true). [language] is an
  /// English language NAME (e.g. "Traditional Chinese") derived from the app
  /// locale so the regenerated doc comes back in the user's language (W6);
  /// omit it to keep the backend's default-language behavior. [runId] is a
  /// client-generated id for the agent tool-trace doc the UI streams while the
  /// agent drafts + self-reviews the handoff (omit to skip the trace).
  Future<String> generateHandoff({
    required String repoId,
    required String taskId,
    String? language,
    String? runId,
  });
  /// Generates the Summary tab report for the inclusive day range
  /// [startDate]..[endDate] (both YYYY-MM-DD; omit [endDate] for one day).
  /// [language] (W6) is the English language NAME for the app locale; when set,
  /// the narrative is regenerated in that language (counts stay neutral).
  Future<String> summarizeDay({
    required String repoId,
    required String startDate,
    String? endDate,
    String? language,
  });

  /// Asks the AI a question about a period's activity (commits / completed
  /// tasks / Discord discussion + repo history). [date]..[endDate] is the
  /// inclusive scope (omit [endDate] for one day). The backend runs an agentic
  /// loop and returns the answer plus the commits it surfaced. [history] is
  /// prior turns, oldest first, for follow-up context.
  Future<DailyBriefReply> dailyBrief({
    required String repoId,
    required String date,
    String? endDate,
    required String question,
    List<DailyBriefTurn> history = const [],
  });

  /// Asks the repo-wide AI assistant a question (the global "Ask GitSync"
  /// chat). The backend runs an agentic loop over the full read-only tool set
  /// and returns the answer plus the commits + Discord clusters it surfaced.
  /// [history] is prior turns, oldest first, for follow-up context. [runId] is a
  /// client-generated id for the agent tool-trace doc the UI streams while
  /// waiting (omit to skip the trace).
  Future<AskRepoReply> askRepo({
    required String repoId,
    required String question,
    List<AskRepoTurn> history = const [],
    String? runId,
  });

  /// Asks the AI to explain the work behind one commit (the commit tree map's
  /// tap action). Returns markdown; the backend caches it on the commit doc.
  /// [language] (W6) is the English language NAME for the app locale; on a
  /// recompute ([force] = true) it makes the summary come back in that language.
  Future<String> explainCommit({
    required String repoId,
    required String sha,
    bool force = false,
    String? language,
    String? runId,
  });

  /// Asks the AI to summarize what one commit author worked on across the
  /// repo's history. [login] is the canonical GitHub login when known (sent
  /// only when non-null); [names] are the git names seen for that author
  /// bucket. Returns markdown; the backend caches it per author key.
  Future<String> summarizeAuthorWork({
    required String repoId,
    String? login,
    List<String> names = const [],
    bool force = false,
  });

  /// Branch-topology data for the Commits tab's branch-graph view: commits
  /// with parent SHAs + branch tips, fetched on demand from the GitHub API
  /// (commit docs carry no parents). [startDate]..[endDate] is the inclusive
  /// day range (both YYYY-MM-DD, both or neither; omit for "recent").
  Future<CommitGraph> getCommitGraph({
    required String repoId,
    String? startDate,
    String? endDate,
    bool force = false,
  });

  // ---- Discord -----------------------------------------------------------

  Future<void> setDiscordWebhook({
    required String repoId,
    required String webhookUrl,
    required List<String> channelIds,
  });

  /// Enqueues an on-demand Discord backfill for [date] (YYYY-MM-DD). The
  /// always-on bot later claims the request, backfills the day's messages, and
  /// the backend produces a `discordDigests/{date}` doc. Returns the request id.
  Future<String> requestDiscordFetch({
    required String repoId,
    required String date,
  });

  /// Sets the Discord backfill start date (YYYY-MM-DD) for every channel bound
  /// to [repoId] and resets their watermarks so the next fetch re-pulls from
  /// the new start (existing messages are deduped, not duplicated).
  Future<void> setDiscordStartDate({
    required String repoId,
    required String startDate,
  });

  /// Sets the Discord backfill date range ([startDate]..[endDate], both
  /// YYYY-MM-DD) for every channel bound to [repoId] and resets their
  /// watermarks so the next fetch re-pulls the range (existing messages are
  /// deduped, not duplicated).
  Future<void> setDiscordRange({
    required String repoId,
    required String startDate,
    required String endDate,
  });

  /// Asks the AI to rewrite the digest for [date] (YYYY-MM-DD) per
  /// [instruction]. Returns the new markdown. Throws if the digest is locked.
  /// [runId] is a client-generated id for the agent tool-trace doc the UI
  /// streams while the agent gathers evidence + rewrites (omit to skip).
  Future<String> editDiscordDigest({
    required String repoId,
    required String date,
    required String instruction,
    String? runId,
  });

  /// Locks (freezes) or unlocks the digest for [date]. A locked digest is not
  /// changed by auto-regeneration or AI edits.
  Future<void> setDigestLock({
    required String repoId,
    required String date,
    required bool locked,
  });

  /// Asks the AI a question about this repo's Discord chat. The backend runs an
  /// agentic loop: it searches the ingested messages, then answers. Returns the
  /// answer plus the messages it surfaced (for the scrollable "sources" panel).
  /// [history] is prior turns, oldest first, for follow-up context.
  /// [startDate]..[endDate] (both YYYY-MM-DD, both-or-neither) scope the read to
  /// a time window; omit both for an unscoped (recent-messages) read.
  Future<DiscordChatReply> discordChat({
    required String repoId,
    required String question,
    List<DiscordChatTurn> history = const [],
    String? startDate,
    String? endDate,
    String? runId,
  });

  // ---- FCM ---------------------------------------------------------------

  Future<void> subscribeToTopic({
    required String token,
    required String topic,
  });
}

class _LiveFunctionsService implements FunctionsService {
  _LiveFunctionsService()
      : _functions = FirebaseFunctions.instanceFor(region: 'asia-east1');

  final FirebaseFunctions _functions;

  HttpsCallable _callable(String name) => _functions.httpsCallable(name);

  @override
  Future<String> addRepo({required String githubUrl}) async {
    final res = await _callable('addRepo').call({'githubUrl': githubUrl});
    final data = Map<String, dynamic>.from(res.data as Map);
    return data['repoId'] as String;
  }

  @override
  Future<void> removeRepo({required String repoId}) async {
    await _callable('removeRepo').call({'repoId': repoId});
  }

  @override
  Future<({int added, int alreadyMembers, List<String> pending})>
      importCollaborators({required String repoId}) async {
    final res = await _callable('importCollaborators').call({'repoId': repoId});
    final data = Map<String, dynamic>.from(res.data as Map);
    return (
      added: (data['added'] as num?)?.toInt() ?? 0,
      alreadyMembers: (data['alreadyMembers'] as num?)?.toInt() ?? 0,
      pending: List<String>.from(data['pending'] as List? ?? const []),
    );
  }

  @override
  Future<List<SubTask>> breakdownTask({
    required String repoId,
    required String goal,
    String? language,
  }) async {
    final res = await _callable('breakdownTask').call({
      'repoId': repoId,
      'goal': goal,
      // Only sent when present; absent → backend follows the spec's language.
      'language': ?language,
    });
    final data = Map<String, dynamic>.from(res.data as Map);
    return (data['subtasks'] as List)
        .map((m) => SubTask.fromMap(Map<String, dynamic>.from(m as Map)))
        .toList();
  }

  @override
  Future<void> forceUnlockBreakdown({required String repoId}) async {
    await _callable('forceUnlockBreakdown').call({'repoId': repoId});
  }

  @override
  Future<int> deleteAllTasks({required String repoId}) async {
    final res = await _callable('deleteAllTasks').call({'repoId': repoId});
    final data = Map<String, dynamic>.from(res.data as Map);
    return (data['deleted'] as num?)?.toInt() ?? 0;
  }

  @override
  Future<({String assigneeId, String reasoning})> assignTask({
    required String repoId,
    required String taskId,
  }) async {
    final res = await _callable('assignTask').call({
      'repoId': repoId,
      'taskId': taskId,
    });
    final data = Map<String, dynamic>.from(res.data as Map);
    return (
      assigneeId: data['assigneeId'] as String,
      reasoning: data['reasoning'] as String,
    );
  }

  @override
  Future<String> generateHandoff({
    required String repoId,
    required String taskId,
    String? language,
    String? runId,
  }) async {
    final res = await _callable('generateHandoff').call({
      'repoId': repoId,
      'taskId': taskId,
      // Only sent on an explicit regenerate; absent → backend default language.
      'language': ?language,
      // Client-generated trace doc id; absent → backend skips the trace.
      'runId': ?runId,
    });
    final data = Map<String, dynamic>.from(res.data as Map);
    return data['handoffMarkdown'] as String;
  }

  @override
  Future<String> summarizeDay({
    required String repoId,
    required String startDate,
    String? endDate,
    String? language,
  }) async {
    final res = await _callable('summarizeDay').call({
      'repoId': repoId,
      'startDate': startDate,
      'endDate': endDate ?? startDate,
      'language': ?language,
    });
    final data = Map<String, dynamic>.from(res.data as Map);
    return data['summary'] as String;
  }

  @override
  Future<DailyBriefReply> dailyBrief({
    required String repoId,
    required String date,
    String? endDate,
    required String question,
    List<DailyBriefTurn> history = const [],
  }) async {
    final res = await _callable('dailyBrief').call({
      'repoId': repoId,
      'date': date,
      'endDate': ?endDate,
      'question': question,
      'history': history.map((t) => t.toMap()).toList(),
    });
    return DailyBriefReply.fromMap(Map<String, dynamic>.from(res.data as Map));
  }

  @override
  Future<AskRepoReply> askRepo({
    required String repoId,
    required String question,
    List<AskRepoTurn> history = const [],
    String? runId,
  }) async {
    final res = await _callable('askRepo').call({
      'repoId': repoId,
      'question': question,
      'history': history.map((t) => t.toMap()).toList(),
      // Carried in so the backend writes the trace doc the UI is streaming.
      'runId': ?runId,
    });
    return AskRepoReply.fromMap(Map<String, dynamic>.from(res.data as Map));
  }

  @override
  Future<String> explainCommit({
    required String repoId,
    required String sha,
    bool force = false,
    String? language,
    String? runId,
  }) async {
    final res = await _callable('explainCommit').call({
      'repoId': repoId,
      'sha': sha,
      'force': force,
      // Only sent on a recompute; absent → backend default language.
      'language': ?language,
      // Client-generated trace doc id; absent → backend skips the trace.
      'runId': ?runId,
    });
    final data = Map<String, dynamic>.from(res.data as Map);
    return data['markdown'] as String;
  }

  @override
  Future<String> summarizeAuthorWork({
    required String repoId,
    String? login,
    List<String> names = const [],
    bool force = false,
  }) async {
    final res = await _callable('summarizeAuthorWork').call({
      'repoId': repoId,
      // Send login only when known; name-only buckets omit it.
      'login': ?login,
      'names': names,
      'force': force,
    });
    final data = Map<String, dynamic>.from(res.data as Map);
    return data['markdown'] as String;
  }

  @override
  Future<CommitGraph> getCommitGraph({
    required String repoId,
    String? startDate,
    String? endDate,
    bool force = false,
  }) async {
    final res = await _callable('getCommitGraph').call({
      'repoId': repoId,
      'startDate': ?startDate,
      'endDate': ?endDate,
      'force': force,
    });
    return CommitGraph.fromMap(Map<String, dynamic>.from(res.data as Map));
  }

  @override
  Future<void> setDiscordWebhook({
    required String repoId,
    required String webhookUrl,
    required List<String> channelIds,
  }) async {
    await _callable('setDiscordWebhook').call({
      'repoId': repoId,
      'webhookUrl': webhookUrl,
      'channelIds': channelIds,
    });
  }

  @override
  Future<String> requestDiscordFetch({
    required String repoId,
    required String date,
  }) async {
    final res = await _callable('requestDiscordFetch').call({
      'repoId': repoId,
      'date': date,
    });
    final data = Map<String, dynamic>.from(res.data as Map);
    return data['requestId'] as String;
  }

  @override
  Future<void> setDiscordStartDate({
    required String repoId,
    required String startDate,
  }) async {
    await _callable('setDiscordStartDate').call({
      'repoId': repoId,
      'startDate': startDate,
    });
  }

  @override
  Future<void> setDiscordRange({
    required String repoId,
    required String startDate,
    required String endDate,
  }) async {
    await _callable('setDiscordRange').call({
      'repoId': repoId,
      'startDate': startDate,
      'endDate': endDate,
    });
  }

  @override
  Future<String> editDiscordDigest({
    required String repoId,
    required String date,
    required String instruction,
    String? runId,
  }) async {
    final res = await _callable('editDiscordDigest').call({
      'repoId': repoId,
      'date': date,
      'instruction': instruction,
      // Client-generated trace doc id; absent → backend skips the trace.
      'runId': ?runId,
    });
    final data = Map<String, dynamic>.from(res.data as Map);
    return data['markdown'] as String;
  }

  @override
  Future<void> setDigestLock({
    required String repoId,
    required String date,
    required bool locked,
  }) async {
    await _callable('setDigestLock').call({
      'repoId': repoId,
      'date': date,
      'locked': locked,
    });
  }

  @override
  Future<DiscordChatReply> discordChat({
    required String repoId,
    required String question,
    List<DiscordChatTurn> history = const [],
    String? startDate,
    String? endDate,
    String? runId,
  }) async {
    final res = await _callable('discordChat').call({
      'repoId': repoId,
      'question': question,
      'history': history.map((t) => t.toMap()).toList(),
      // Only sent when scoped; the backend treats absent as unscoped (D2).
      'startDate': ?startDate,
      'endDate': ?endDate,
      // Client-generated trace doc id; absent → backend skips the trace.
      'runId': ?runId,
    });
    return DiscordChatReply.fromMap(Map<String, dynamic>.from(res.data as Map));
  }

  @override
  Future<void> subscribeToTopic({
    required String token,
    required String topic,
  }) async {
    await _callable('subscribeToTopic').call({'token': token, 'topic': topic});
  }
}
