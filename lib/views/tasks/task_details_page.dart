import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../l10n/app_strings.dart';
import '../../models/agent_run.dart';
import '../../models/app_user.dart';
import '../../models/member.dart';
import '../../models/task.dart';
import '../../repositories/agent_run_repo.dart';
import '../../services/functions_service.dart';
import '../../services/navigation.dart';
import '../../theme/app_dimens.dart';
import '../../theme/app_motion.dart';
import '../../widgets/section_card.dart';
import '../../view_models/graph_edit_ops.dart';
import '../../view_models/members_vm.dart';
import '../../view_models/repo_vm.dart';
import '../../view_models/tasks_board_vm.dart';
import '../../widgets/markdown_view.dart';
import '../ask/ask_repo_chat.dart' show AskRepoLiveTraceStrip;
import 'widgets/status_picker.dart';

// Sentinels returned by the assignee picker: clear the assignee, or trigger a
// GitHub-collaborator import (vs. `null` = dismissed, or a uid = pick that user).
const String _kUnassign = '__unassign__';
const String _kImport = '__import__';

// Full task-detail view: status, assignee (with inline picker), description,
// implementation details (acceptance criteria), subtasks, dependencies, linked
// GitHub issue / PRs, and the AI handoff doc. Reads tasks + member profiles from
// the repo-scoped ViewModels provided by the shell route.
class TaskDetailsPage extends StatefulWidget {
  const TaskDetailsPage({
    super.key,
    required this.repoId,
    required this.taskId,
  });

  final String repoId;
  final String taskId;

  @override
  State<TaskDetailsPage> createState() => _TaskDetailsPageState();
}

class _TaskDetailsPageState extends State<TaskDetailsPage> {
  bool _generatingHandoff = false;
  // Holds the just-generated handoff so the UI reflects it immediately even when
  // the backend doesn't persist it back into the task stream (fake mode).
  String? _localHandoff;

  // Live agent tool-trace for the in-flight handoff regenerate: the backend
  // streams its "thinking" steps (reading commits, searching Discord, drafting,
  // self-reviewing…) into an agentRuns doc while the callable runs, so the user
  // sees progress instead of a bare spinner. Mirrors [AskRepoViewModel].
  final AgentRunRepository _agentRuns = AgentRunRepository();
  List<AgentStep> _handoffSteps = const [];
  StreamSubscription<AgentRun?>? _handoffTraceSub;
  static final _rng = Random();

  /// A unique, path-safe trace doc id, generated BEFORE the callable so the UI
  /// can subscribe immediately (the callable carries it in). The `handoff-`
  /// prefix lets the fake trace repo pick handoff-flavored demo steps.
  static String _newHandoffRunId() {
    final ts = DateTime.now().microsecondsSinceEpoch;
    // 30 bits (web-safe; 1<<32 overflows to 0 on JS) + microsecond ts ≈ unique.
    final nonce = _rng.nextInt(1 << 30).toRadixString(16);
    return 'handoff-$ts-$nonce';
  }

  Future<void> _regenerateHandoff(Task task) async {
    if (_generatingHandoff) return;
    final s = context.l10n;
    final functions = context.read<FunctionsService>();
    final messenger = ScaffoldMessenger.of(context);
    final runId = _newHandoffRunId();
    setState(() {
      _generatingHandoff = true;
      _handoffSteps = const [];
    });

    // Subscribe to the trace doc so steps appear live while the callable runs.
    _handoffTraceSub = _agentRuns.watch(widget.repoId, runId).listen((run) {
      if (run == null || !mounted) return;
      setState(() => _handoffSteps = run.steps);
    });

    try {
      final markdown = await functions.generateHandoff(
        repoId: widget.repoId,
        taskId: task.id,
        // W6: regenerate in the app's current language.
        language: s.backendLanguage,
        runId: runId,
      );
      if (!mounted) return;
      setState(() => _localHandoff = markdown);
    } catch (_) {
      if (!mounted) return;
      messenger
        ..clearSnackBars()
        ..showSnackBar(
          SnackBar(content: Text(s.couldNotGenerateHandoff)),
        );
    } finally {
      // Fire-and-forget cancel: never block completion on tearing down the
      // trace stream (a closed stream's cancel can stay pending).
      unawaited(_handoffTraceSub?.cancel() ?? Future<void>.value());
      _handoffTraceSub = null;
      if (mounted) {
        setState(() {
          _generatingHandoff = false;
          _handoffSteps = const [];
        });
      }
    }
  }

  @override
  void dispose() {
    _handoffTraceSub?.cancel();
    super.dispose();
  }

  Future<void> _importCollaborators() async {
    final s = context.l10n;
    final functions = context.read<FunctionsService>();
    final messenger = ScaffoldMessenger.of(context);
    messenger
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(content: Text(s.importingCollaborators)),
      );
    try {
      final r = await functions.importCollaborators(repoId: widget.repoId);
      if (!mounted) return;
      messenger
        ..clearSnackBars()
        ..showSnackBar(
          SnackBar(
            content: Text(
              s.importedSummary(r.added, r.alreadyMembers, r.pending.length),
            ),
          ),
        );
    } catch (_) {
      if (!mounted) return;
      messenger
        ..clearSnackBars()
        ..showSnackBar(
          SnackBar(content: Text(s.couldNotImport)),
        );
    }
  }

  Future<void> _openUrl(String url) async {
    final s = context.l10n;
    final messenger = ScaffoldMessenger.of(context);
    final ok = await launchUrl(
      Uri.parse(url),
      mode: LaunchMode.externalApplication,
    );
    if (!ok && mounted) {
      messenger
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(s.couldNotOpenLink)));
    }
  }

  Future<void> _pickAssignee(Task task) async {
    final s = context.l10n;
    final tasksVm = context.read<TasksBoardViewModel>();
    final membersVm = context.read<MembersViewModel>();
    final messenger = ScaffoldMessenger.of(context);

    final result = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      // Tune enter/exit to match the app's sheet timing (06-13).
      sheetAnimationStyle: AppMotion.sheetStyle,
      builder: (ctx) => _AssigneePicker(
        members: membersVm.members,
        membersVm: membersVm,
        currentAssigneeId: task.assigneeId,
      ),
    );
    if (result == null) return; // dismissed
    if (result == _kImport) {
      await _importCollaborators();
      return;
    }
    final newAssignee = result == _kUnassign ? null : result;
    if (newAssignee == task.assigneeId) return;

    try {
      await tasksVm.assignTo(task.id, newAssignee);
    } catch (_) {
      if (!mounted) return;
      messenger
        ..clearSnackBars()
        ..showSnackBar(
          SnackBar(content: Text(s.couldNotUpdateAssignee)),
        );
    }
  }

  // Open the shared three-state picker for the main task's status chip and
  // write the chosen status through the board ViewModel (stream refreshes the
  // chip). Picking the current status (or dismissing) is a no-op.
  Future<void> _changeStatus(Task task) async {
    final s = context.l10n;
    final tasksVm = context.read<TasksBoardViewModel>();
    final messenger = ScaffoldMessenger.of(context);
    final picked = await showStatusPicker(context, current: task.status);
    if (picked == null || picked == task.status) return;
    try {
      await tasksVm.updateStatus(task.id, picked);
    } catch (e) {
      if (!mounted) return;
      messenger
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(s.updateStatusFailed(e))));
    }
  }

  // Open a scrollable picker of tasks eligible to become a prerequisite of
  // [task] (excludes itself, current prerequisites, and any choice that would
  // create a cycle), then link the picked one.
  Future<void> _addPrerequisite(Task task) async {
    final s = context.l10n;
    final vm = context.read<TasksBoardViewModel>();
    final messenger = ScaffoldMessenger.of(context);
    final deps = {for (final t in vm.tasks) t.id: t.dependsOn};
    final candidates = vm.tasks
        .where((t) =>
            t.id != task.id &&
            !task.dependsOn.contains(t.id) &&
            !wouldCreateCycle(deps, task.id, t.id))
        .toList();
    if (candidates.isEmpty) {
      messenger
        ..clearSnackBars()
        ..showSnackBar(
          SnackBar(content: Text(s.noEligibleTasks)),
        );
      return;
    }
    final picked = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      // Tune enter/exit to match the app's sheet timing (06-13).
      sheetAnimationStyle: AppMotion.sheetStyle,
      builder: (ctx) => _PrereqPicker(candidates: candidates),
    );
    if (picked == null || !mounted) return;
    final ok = await vm.addDependency(task.id, picked);
    if (!mounted || ok) return;
    messenger
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(content: Text(s.couldNotAddPrereq)),
      );
  }

  Future<void> _removePrerequisite(Task task, String prereqId) async {
    await context.read<TasksBoardViewModel>().removeDependency(task.id, prereqId);
  }

  Future<void> _deleteCurrentTask() async {
    final s = context.l10n;
    final vm = context.read<TasksBoardViewModel>();
    final nav = context.read<NavigationService>();
    Task? task;
    for (final t in vm.tasks) {
      if (t.id == widget.taskId) {
        task = t;
        break;
      }
    }
    if (task == null) return;
    // showGeneralDialog (not showDialog) so we can tune duration + curve and
    // animate the barrier in sync with the dialog. The scrim ramps with the
    // primary animation; the dialog itself fades + scales on emphasizedDecel.
    final theme = Theme.of(context);
    final confirmed = await showGeneralDialog<bool>(
      context: context,
      barrierDismissible: true,
      barrierLabel: MaterialLocalizations.of(context).modalBarrierDismissLabel,
      // Transparent barrier — the transitionBuilder paints a fading scrim so
      // its opacity matches the dialog's curve.
      barrierColor: Colors.transparent,
      transitionDuration: AppMotion.medium,
      pageBuilder: (ctx, _, _) => AlertDialog(
        title: Text(s.deleteTaskQuestion),
        content: Text(s.deleteTaskBody(task!.title)),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(s.cancel),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(
              s.delete,
              style: TextStyle(color: Theme.of(ctx).colorScheme.error),
            ),
          ),
        ],
      ),
      transitionBuilder: (ctx, anim, _, child) {
        final curved = CurvedAnimation(
          parent: anim,
          curve: AppMotion.emphasizedDecel,
          reverseCurve: AppMotion.emphasizedAccel,
        );
        // Hand-rolled scrim so its alpha follows the same curve.
        final scrim = theme.colorScheme.scrim;
        return AnimatedBuilder(
          animation: curved,
          builder: (_, _) => ColoredBox(
            color: Color.lerp(
                  Colors.transparent,
                  scrim.withValues(alpha: 0.32),
                  curved.value,
                ) ??
                Colors.transparent,
            child: Opacity(
              opacity: curved.value,
              child: Transform.scale(
                scale: 0.96 + 0.04 * curved.value,
                child: child,
              ),
            ),
          ),
        );
      },
    );
    if (confirmed != true || !mounted) return;
    await vm.deleteTaskBridging(widget.taskId);
    if (!mounted) return;
    nav.goTasks(widget.repoId);
  }

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    return Scaffold(
      appBar: AppBar(
        title: Text(s.taskDetailsTitle),
        actions: [
          IconButton(
            icon: const Icon(Icons.delete_outline),
            tooltip: s.deleteTaskTooltip,
            onPressed: _deleteCurrentTask,
          ),
        ],
      ),
      body: Consumer2<TasksBoardViewModel, MembersViewModel>(
        builder: (ctx, tasksVm, membersVm, _) {
          final task = tasksVm.tasks.firstWhere(
            (t) => t.id == widget.taskId,
            orElse: () =>
                Task(id: widget.taskId, title: '(deleted)', createdBy: ''),
          );
          final theme = Theme.of(ctx);

          final byId = {for (final t in tasksVm.tasks) t.id: t};
          final deps = [
            for (final id in task.dependsOn)
              if (byId[id] != null) byId[id]!,
          ];
          final subtasks = [
            for (final t in tasksVm.tasks)
              if (t.parentTaskId == task.id) t,
          ];
          // A just-regenerated handoff (local) wins over the persisted one so
          // the result shows immediately even when the backend doesn't write it
          // back into the stream (fake mode).
          final handoff = _localHandoff ?? task.handoffDoc;
          // Repo URL (from the shell-scoped RepoViewModel) lets us deep-link the
          // linked GitHub issue / PRs; null/empty → chips stay non-tappable.
          final repoUrl = ctx.watch<RepoViewModel>().repo?.url;
          final hasRepoUrl = repoUrl != null && repoUrl.isNotEmpty;

          final scheme = theme.colorScheme;

          return ListView(
            padding: const EdgeInsets.all(AppDimens.spacingMd),
            children: [
              // ---- Assignee card ----
              SectionCard(
                child: InkWell(
                  borderRadius: BorderRadius.circular(AppDimens.radiusMd),
                  onTap: () => _pickAssignee(task),
                  child: Row(
                    children: [
                      Expanded(
                        child: _AssigneeCardBody(
                          assigneeId: task.assigneeId,
                          membersVm: membersVm,
                        ),
                      ),
                      const SizedBox(width: AppDimens.spacingSm),
                      _StatusChip(
                        status: task.status,
                        onTap: () => _changeStatus(task),
                      ),
                      const SizedBox(width: AppDimens.spacingXs),
                      Icon(Icons.chevron_right,
                          color: scheme.onSurfaceVariant, size: 20),
                    ],
                  ),
                ),
              ),

              const SizedBox(height: AppDimens.spacingMd),

              // ---- Task content card (description + subtasks) ----
              SectionCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Header row: icon + title.
                    Row(
                      children: [
                        Icon(Icons.description_outlined,
                            size: 20, color: scheme.primary),
                        const SizedBox(width: AppDimens.spacingSm),
                        Text(
                          s.taskContent,
                          style: theme.textTheme.titleMedium?.copyWith(
                            color: scheme.primary,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ],
                    ),
                    const Divider(height: AppDimens.spacingLg),

                    // Description sub-section.
                    Text(
                      s.descriptionSection,
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: scheme.primary,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: AppDimens.spacingSm),
                    // Blue dot + task title.
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Container(
                            width: 10,
                            height: 10,
                            decoration: BoxDecoration(
                              color: scheme.primary,
                              shape: BoxShape.circle,
                            ),
                          ),
                        ),
                        const SizedBox(width: AppDimens.spacingSm),
                        Expanded(
                          child: Text(
                            task.title,
                            style: theme.textTheme.bodyLarge?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                    ),
                    // Description text in a tinted rounded box.
                    if (task.description.isNotEmpty) ...[
                      const SizedBox(height: AppDimens.spacingSm),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(AppDimens.spacingMd),
                        decoration: BoxDecoration(
                          color: scheme.surfaceContainerHighest
                              .withValues(alpha:
                                  theme.brightness == Brightness.light
                                      ? 0.5
                                      : 0.8),
                          borderRadius:
                              BorderRadius.circular(AppDimens.radiusSm),
                        ),
                        child: Text(
                          task.description,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: scheme.onSurfaceVariant,
                          ),
                        ),
                      ),
                    ],

                    // Subtasks sub-section.
                    if (subtasks.isNotEmpty) ...[
                      const SizedBox(height: AppDimens.spacingLg),
                      Text(
                        s.subtasks,
                        style: theme.textTheme.labelMedium?.copyWith(
                          color: scheme.primary,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: AppDimens.spacingSm),
                      for (var i = 0; i < subtasks.length; i++) ...[
                        InkWell(
                          borderRadius:
                              BorderRadius.circular(AppDimens.radiusSm),
                          onTap: () =>
                              Provider.of<NavigationService>(context,
                                      listen: false)
                                  .goTaskDetails(widget.repoId, subtasks[i].id),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                                vertical: AppDimens.spacingSm),
                            child: Row(
                              children: [
                                Icon(
                                  subtasks[i].status == TaskStatus.done
                                      ? Icons.check_box
                                      : Icons.check_box_outline_blank,
                                  size: 22,
                                  color: subtasks[i].status == TaskStatus.done
                                      ? scheme.primary
                                      : scheme.outline,
                                ),
                                const SizedBox(width: AppDimens.spacingSm),
                                Expanded(
                                  child: Text(
                                    subtasks[i].title,
                                    style: theme.textTheme.bodyMedium,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                        if (i < subtasks.length - 1)
                          const Divider(height: 1),
                      ],
                    ],
                  ],
                ),
              ),

              const SizedBox(height: AppDimens.spacingMd),

              // ---- Dependencies card ----
              SectionCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Icon(Icons.link, size: 20, color: scheme.primary),
                        const SizedBox(width: AppDimens.spacingSm),
                        Expanded(
                          child: Text(
                            s.dependsOn,
                            style: theme.textTheme.titleMedium?.copyWith(
                              color: scheme.primary,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                        IconButton(
                          onPressed: () => _addPrerequisite(task),
                          icon: const Icon(Icons.add, size: 20),
                          tooltip: s.add,
                        ),
                      ],
                    ),
                    const Divider(height: AppDimens.spacingMd),
                    if (deps.isEmpty)
                      Text(
                        s.noPrerequisites,
                        style: theme.textTheme.bodyMedium
                            ?.copyWith(color: scheme.onSurfaceVariant),
                      )
                    else
                      for (final t in deps)
                        _TaskRefTile(
                          repoId: widget.repoId,
                          task: t,
                          onRemove: () => _removePrerequisite(task, t.id),
                        ),
                  ],
                ),
              ),

              // ---- GitHub links card ----
              if (task.githubIssueNumber != null ||
                  task.linkedPRNumbers.isNotEmpty) ...[
                const SizedBox(height: AppDimens.spacingMd),
                SectionCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Icon(Icons.code, size: 20, color: scheme.primary),
                          const SizedBox(width: AppDimens.spacingSm),
                          Text(
                            'GitHub',
                            style: theme.textTheme.titleMedium?.copyWith(
                              color: scheme.primary,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ],
                      ),
                      const Divider(height: AppDimens.spacingMd),
                      Wrap(
                        spacing: AppDimens.spacingSm,
                        runSpacing: AppDimens.spacingSm,
                        children: [
                          if (task.githubIssueNumber != null)
                            _RefChip(
                              icon: Icons.adjust,
                              label: 'Issue #${task.githubIssueNumber}',
                              onTap: hasRepoUrl
                                  ? () => _openUrl(
                                      '$repoUrl/issues/${task.githubIssueNumber}')
                                  : null,
                            ),
                          for (final pr in task.linkedPRNumbers)
                            _RefChip(
                              icon: Icons.merge,
                              label: 'PR #$pr',
                              onTap: hasRepoUrl
                                  ? () => _openUrl('$repoUrl/pull/$pr')
                                  : null,
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],

              // ---- Handoff doc card ----
              const SizedBox(height: AppDimens.spacingMd),
              SectionCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Icon(Icons.auto_awesome,
                            size: 20, color: scheme.primary),
                        const SizedBox(width: AppDimens.spacingSm),
                        Expanded(
                          child: Text(
                            s.handoff,
                            style: theme.textTheme.titleMedium?.copyWith(
                              color: scheme.primary,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                        TextButton(
                          onPressed: _generatingHandoff
                              ? null
                              : () => _regenerateHandoff(task),
                          child: _generatingHandoff
                              ? const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                      strokeWidth: 2),
                                )
                              : Text(
                                  handoff == null ? s.generate : s.regenerate,
                                ),
                        ),
                      ],
                    ),
                    const Divider(height: AppDimens.spacingMd),
                    // While regenerating, stream the agent's live "thinking"
                    // steps (Claude-Code-style) above the existing doc; the
                    // finished markdown replaces them once the callable returns.
                    if (_generatingHandoff)
                      AskRepoLiveTraceStrip(steps: _handoffSteps)
                    else if (handoff == null)
                      Text(
                        s.noHandoffYet,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      )
                    else
                      MarkdownView(data: handoff),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

// Status pill, shared by the header + task-reference tiles. When [onTap] is
// set (only the main task's chip) it becomes a tappable status editor with a
// dropdown affordance; related-task tiles leave it null (read-only).
class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status, this.onTap});
  final TaskStatus status;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final (bg, fg) = switch (status) {
      TaskStatus.todo => (scheme.surfaceContainerHighest, scheme.onSurface),
      TaskStatus.inProgress => (
          scheme.primaryContainer,
          scheme.onPrimaryContainer,
        ),
      TaskStatus.done => (
          scheme.secondaryContainer,
          scheme.onSecondaryContainer,
        ),
    };
    final content = Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: AppDimens.spacingMd,
        vertical: AppDimens.spacingSm - 2,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            status.wire,
            style: theme.textTheme.labelMedium
                ?.copyWith(color: fg, fontWeight: FontWeight.w700),
          ),
          if (onTap != null) Icon(Icons.arrow_drop_down, size: 18, color: fg),
        ],
      ),
    );
    return Material(
      color: bg,
      borderRadius: BorderRadius.circular(AppDimens.radiusLg),
      clipBehavior: Clip.antiAlias,
      child: onTap == null ? content : InkWell(onTap: onTap, child: content),
    );
  }
}

// White rounded-rect card — now delegates to the shared SectionCard widget.

// Assignee card body: large avatar + "認領者" label + name.
class _AssigneeCardBody extends StatelessWidget {
  const _AssigneeCardBody({
    required this.assigneeId,
    required this.membersVm,
  });

  final String? assigneeId;
  final MembersViewModel membersVm;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final id = assigneeId;
    final profile = id == null ? null : membersVm.profileFor(id);
    // Resolve this assignee's profile on demand (it may not be in the streamed
    // member list yet). Once it lands, the VM notifies and this card rebuilds
    // with the real name instead of the raw UID.
    if (id != null && profile == null) {
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => membersVm.ensureResolved(id),
      );
    }
    // Until the name resolves, show a neutral placeholder rather than the raw,
    // overflow-prone 28-char UID.
    final label = id == null
        ? s.unassigned
        : (profile != null ? membersVm.labelFor(id) : '…');

    return Row(
      children: [
        _Avatar(user: profile, fallbackSeed: id, radius: 24),
        const SizedBox(width: AppDimens.spacingMd),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                s.assignee,
                style: theme.textTheme.labelMedium?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodyLarge?.copyWith(
                  fontWeight: FontWeight.w600,
                  color: id == null ? scheme.onSurfaceVariant : null,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

// Bottom-sheet body listing repo members + an "Unassign" option. Pops the
// selected uid (or [_kUnassign]).
class _AssigneePicker extends StatelessWidget {
  const _AssigneePicker({
    required this.members,
    required this.membersVm,
    required this.currentAssigneeId,
  });

  final List<Member> members;
  final MembersViewModel membersVm;
  final String? currentAssigneeId;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    return SafeArea(
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.only(bottom: AppDimens.spacingMd),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppDimens.spacingMd,
              0,
              AppDimens.spacingMd,
              AppDimens.spacingSm,
            ),
            child: Text(
              s.assignToTitle,
              style: theme.textTheme.titleMedium
                  ?.copyWith(fontWeight: FontWeight.w700),
            ),
          ),
          for (final m in members)
            ListTile(
              leading: _Avatar(
                user: membersVm.profileFor(m.userId),
                fallbackSeed: m.userId,
              ),
              title: Text(membersVm.labelFor(m.userId)),
              subtitle: Text(m.role.wire),
              trailing: m.userId == currentAssigneeId
                  ? Icon(Icons.check, color: theme.colorScheme.primary)
                  : null,
              onTap: () => Navigator.of(context).pop(m.userId),
            ),
          const Divider(height: 1),
          ListTile(
            leading: const Icon(Icons.person_off_outlined),
            title: Text(s.unassign),
            enabled: currentAssigneeId != null,
            onTap: () => Navigator.of(context).pop(_kUnassign),
          ),
          ListTile(
            leading: const Icon(Icons.group_add_outlined),
            title: Text(s.importCollaborators),
            subtitle: Text(s.importCollaboratorsSub),
            onTap: () => Navigator.of(context).pop(_kImport),
          ),
        ],
      ),
    );
  }
}

// Round avatar from the user's photo URL, falling back to an initial derived
// from the label / uid.
class _Avatar extends StatelessWidget {
  const _Avatar({required this.user, this.fallbackSeed, this.radius = 16});
  final AppUser? user;
  final String? fallbackSeed;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final url = user?.avatarUrl;
    final seed = (user?.githubLogin.isNotEmpty ?? false)
        ? user!.githubLogin
        : (user?.name.isNotEmpty ?? false)
            ? user!.name
            : (fallbackSeed ?? '?');
    return CircleAvatar(
      radius: radius,
      backgroundColor: scheme.primaryContainer,
      foregroundImage:
          (url != null && url.isNotEmpty) ? NetworkImage(url) : null,
      child: Text(
        seed.isNotEmpty ? seed.characters.first.toUpperCase() : '?',
        style: TextStyle(
          color: scheme.onPrimaryContainer,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

// A tappable row for a related task (subtask / dependency): title + status,
// navigates to that task's detail page.
class _TaskRefTile extends StatelessWidget {
  const _TaskRefTile({
    required this.repoId,
    required this.task,
    this.onRemove,
  });
  final String repoId;
  final Task task;
  // When set, shows a ✕ to unlink this prerequisite.
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    return Card(
      margin: const EdgeInsets.only(bottom: AppDimens.spacingSm),
      child: ListTile(
        title: Text(task.title, maxLines: 2, overflow: TextOverflow.ellipsis),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _StatusChip(status: task.status),
            if (onRemove != null)
              IconButton(
                icon: const Icon(Icons.close, size: 18),
                tooltip: s.removePrerequisite,
                onPressed: onRemove,
              ),
          ],
        ),
        onTap: () => Provider.of<NavigationService>(context, listen: false)
            .goTaskDetails(repoId, task.id),
      ),
    );
  }
}

// Scrollable bottom-sheet picker of tasks that can become a prerequisite.
class _PrereqPicker extends StatelessWidget {
  const _PrereqPicker({required this.candidates});
  final List<Task> candidates;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppDimens.spacingMd,
              0,
              AppDimens.spacingMd,
              AppDimens.spacingSm,
            ),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                s.addPrerequisite,
                style: theme.textTheme.titleMedium
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
            ),
          ),
          Flexible(
            child: ListView.builder(
              shrinkWrap: true,
              itemCount: candidates.length,
              itemBuilder: (ctx, i) {
                final t = candidates[i];
                return ListTile(
                  leading: _StatusChip(status: t.status),
                  title:
                      Text(t.title, maxLines: 2, overflow: TextOverflow.ellipsis),
                  onTap: () => Navigator.of(ctx).pop(t.id),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

// Small outlined chip for a GitHub issue / PR reference. Tappable (opens the
// GitHub URL) when [onTap] is provided; otherwise a plain, non-interactive chip.
class _RefChip extends StatelessWidget {
  const _RefChip({required this.icon, required this.label, this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final avatar = Icon(icon, size: 16, color: scheme.primary);
    final side = BorderSide(color: scheme.outlineVariant);
    if (onTap == null) {
      return Chip(avatar: avatar, label: Text(label), side: side);
    }
    return ActionChip(
      avatar: avatar,
      label: Text(label),
      side: side,
      onPressed: onTap,
    );
  }
}

