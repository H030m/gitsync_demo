// Models for the agent tool-trace side-channel. The backend writes one
// `repos/{repoId}/agentRuns/{runId}` doc per agentic run (askRepo /
// generateHandoff) and appends a step per tool round; the client streams it
// while the callable is still running to show live progress.
//
// `fromMap` tolerates missing/partial fields — the doc is written incrementally
// and may be read mid-write.

/// One progress step the agent recorded (an English label written by the
/// backend, displayed verbatim — see `tools/agentTrace.ts`).
class AgentStep {
  final String label;

  /// ISO 8601 string set by the backend when the step was appended, or null.
  final String? at;

  const AgentStep({required this.label, this.at});

  factory AgentStep.fromMap(Map<String, dynamic> map) => AgentStep(
        label: map['label'] as String? ?? '',
        at: map['at'] as String?,
      );
}

/// A single agent run as the client sees it while streaming the trace doc.
class AgentRun {
  /// `'askRepo'` | `'generateHandoff'`.
  final String flow;

  /// `'running'` | `'done'` | `'error'`.
  final String status;

  /// Append-only progress steps, in write order.
  final List<AgentStep> steps;

  const AgentRun({
    this.flow = '',
    this.status = 'running',
    this.steps = const [],
  });

  bool get isRunning => status == 'running';
  bool get isDone => status == 'done';
  bool get isError => status == 'error';

  factory AgentRun.fromMap(Map<String, dynamic> map) => AgentRun(
        flow: map['flow'] as String? ?? '',
        status: map['status'] as String? ?? 'running',
        steps: (map['steps'] as List? ?? const [])
            .map((s) => AgentStep.fromMap(Map<String, dynamic>.from(s as Map)))
            .toList(),
      );
}
