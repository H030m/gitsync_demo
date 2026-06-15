import '../../config/app_config.dart';
import '../../models/agent_run.dart';
import '../agent_run_repo.dart';

/// Fake agent-trace stream for offline demo mode. There is no real Firestore in
/// fake mode, so this emits a canned sequence of steps — one every
/// [AppConfig.simulatedLatency] — then finishes with `status: 'done'`, so the
/// chat sheet shows the trace lines appearing live before the canned answer
/// resolves (the fake `askRepo` delay is tuned to outlast this stream).
class FakeAgentRunRepository implements AgentRunRepository {
  /// The canned progress the demo `askRepo` agent "performs".
  static const _cannedAskSteps = <String>[
    'Reading .trellis planning docs…',
    'Searching commit history…',
    'Searching Discord…',
    'Composing answer…',
  ];

  /// The canned progress the demo `generateHandoff` agent "performs" — mirrors
  /// the real Phase-1 tool loop + Phase-2 self-review so the demo shows the same
  /// "thinking" lines the live backend writes (see tools/agentTrace.ts).
  static const _cannedHandoffSteps = <String>[
    'Reading .trellis planning docs…',
    'Listing related commits…',
    'Reading a commit diff…',
    'Searching Discord…',
    'Reading team roster…',
    'Drafting the handoff…',
    'Reviewing draft (score 5/5)…',
  ];

  /// The demo `discordChat` agent: locate days, drill in, search, answer.
  static const _cannedChatSteps = <String>[
    'Listing day summaries…',
    'Reading a day digest…',
    'Searching Discord…',
    'Composing answer…',
  ];

  /// The demo `explainCommit` agent: gather context, then write.
  static const _cannedExplainSteps = <String>[
    'Listing nearby commits…',
    'Searching Discord…',
    'Reading a commit diff…',
    'Writing the explanation…',
  ];

  /// The demo `editDiscordDigest` agent: pull evidence, then revise.
  static const _cannedEditDigestSteps = <String>[
    'Searching Discord…',
    'Reading a day digest…',
    'Revising the digest…',
  ];

  // runId prefix → (flow name, canned steps). The first matching prefix wins;
  // unprefixed ids fall through to the askRepo chat default.
  static const _byPrefix = <String, (String, List<String>)>{
    'handoff-': ('generateHandoff', _cannedHandoffSteps),
    'chat-': ('discordChat', _cannedChatSteps),
    'explain-': ('explainCommit', _cannedExplainSteps),
    'editdigest-': ('editDiscordDigest', _cannedEditDigestSteps),
  };

  @override
  Stream<AgentRun?> watch(String repoId, String runId) async* {
    // The trace-driving screens prefix their runId by flow (handoff- / chat- /
    // explain- / editdigest-); everything else is the askRepo chat. Pick the
    // matching canned trace so the demo lines fit what the user is watching.
    var flow = 'askRepo';
    var cannedSteps = _cannedAskSteps;
    for (final entry in _byPrefix.entries) {
      if (runId.startsWith(entry.key)) {
        flow = entry.value.$1;
        cannedSteps = entry.value.$2;
        break;
      }
    }

    // Doc doesn't exist yet.
    yield null;

    final steps = <AgentStep>[];
    for (final label in cannedSteps) {
      await Future.delayed(AppConfig.simulatedLatency);
      steps.add(AgentStep(label: label, at: DateTime.now().toIso8601String()));
      yield AgentRun(
        flow: flow,
        status: 'running',
        steps: List.unmodifiable(steps),
      );
    }
    yield AgentRun(
      flow: flow,
      status: 'done',
      steps: List.unmodifiable(steps),
    );
  }
}
