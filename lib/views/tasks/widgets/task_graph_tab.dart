import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:graphview/GraphView.dart';
import 'package:provider/provider.dart';

import '../../../l10n/app_strings.dart';
import '../../../models/task.dart';
import '../../../services/authentication.dart';
import '../../../services/navigation.dart';
import '../../../theme/app_dimens.dart';
import '../../../view_models/tasks_board_vm.dart';

// Dependency-DAG visualization of a repo's tasks (TasksBoardPage "關聯圖" tab).
// Nodes = tasks, edges = `dependsOn` (prerequisite -> dependent). Built with the
// `graphview` package using a top-down Sugiyama (layered) layout, wrapped in an
// InteractiveViewer for pan/zoom. See task 06-02-task-graph-view.
//
// 06-06 layout polish: keep the top-down Sugiyama orientation but make it read
// cleanly — open level spacing, tighter in-layer gaps, uniform node size, softer
// short edges, a status legend, and a one-time fit-to-view so the whole graph is
// framed on open (the long sweeping edges over empty canvas were the eyesore).
class TaskGraphTab extends StatefulWidget {
  const TaskGraphTab({super.key, required this.vm});

  final TasksBoardViewModel vm;

  @override
  State<TaskGraphTab> createState() => _TaskGraphTabState();
}

class _TaskGraphTabState extends State<TaskGraphTab> {
  final _transform = TransformationController();
  // Key on the laid-out graph so we can measure it and fit it to the viewport.
  final _graphKey = GlobalKey();
  // Fit-to-view runs once per built graph; re-armed when the task set changes.
  bool _fitted = false;
  int _fitSignature = 0;
  // When set, we're in connect mode: this node is the prerequisite, and the next
  // tapped node becomes its dependent.
  String? _linkSource;

  @override
  void dispose() {
    _transform.dispose();
    super.dispose();
  }

  void _onNodeTap(Task task) {
    if (_linkSource != null) {
      _connectTo(task.id);
    } else {
      Provider.of<NavigationService>(context, listen: false)
          .goTaskDetails(widget.vm.repoId, task.id);
    }
  }

  Future<void> _connectTo(String targetId) async {
    final s = context.l10n;
    final source = _linkSource;
    setState(() => _linkSource = null);
    if (source == null || source == targetId) return;
    final messenger = ScaffoldMessenger.of(context);
    // Target depends on the source (source is the prerequisite).
    final ok = await widget.vm.addDependency(targetId, source);
    if (!mounted) return;
    messenger
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(
          content: Text(ok ? s.dependencyAdded : s.cannotLink),
        ),
      );
  }

  Future<void> _showNodeMenu(Task task, Offset globalPos) async {
    final s = context.l10n;
    final choice = await showMenu<String>(
      context: context,
      position: RelativeRect.fromLTRB(
        globalPos.dx,
        globalPos.dy,
        globalPos.dx,
        globalPos.dy,
      ),
      items: [
        PopupMenuItem(value: 'open', child: Text(s.openDetails)),
        PopupMenuItem(value: 'link', child: Text(s.linkFromHere)),
        PopupMenuItem(value: 'delete', child: Text(s.delete)),
      ],
    );
    if (!mounted || choice == null) return;
    switch (choice) {
      case 'open':
        Provider.of<NavigationService>(context, listen: false)
            .goTaskDetails(widget.vm.repoId, task.id);
      case 'link':
        setState(() => _linkSource = task.id);
      case 'delete':
        _confirmDelete(task);
    }
  }

  Future<void> _confirmDelete(Task task) async {
    final s = context.l10n;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.deleteTaskQuestion),
        content: Text(s.deleteTaskBody(task.title)),
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
    );
    if (confirmed != true || !mounted) return;
    await widget.vm.deleteTaskBridging(task.id);
  }

  Future<void> _addNodeDialog() async {
    final s = context.l10n;
    final controller = TextEditingController();
    final messenger = ScaffoldMessenger.of(context);
    final uid =
        Provider.of<AuthenticationService>(context, listen: false).currentUid;
    final title = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.addTaskTitle),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: InputDecoration(hintText: s.taskTitleLabel),
          onSubmitted: (v) => Navigator.of(ctx).pop(v),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: Text(s.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(controller.text),
            child: Text(s.add),
          ),
        ],
      ),
    );
    controller.dispose();
    if (title == null || title.trim().isEmpty || !mounted) return;
    await widget.vm.addTask(Task(id: '', title: title.trim(), createdBy: uid ?? ''));
    if (!mounted) return;
    messenger
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(s.taskAdded)));
  }

  // Frame the whole graph in the viewport the first time it lays out: scale to
  // fit (never zoom past 1×) and center. Guarded so it doesn't fight the user's
  // pan/zoom afterwards.
  void _maybeFit(Size viewport) {
    if (_fitted || viewport.isEmpty) return;
    final ctx = _graphKey.currentContext;
    final size = ctx?.size;
    if (size == null || size.width == 0 || size.height == 0) return;
    final scale = math
        .min(viewport.width / size.width, viewport.height / size.height)
        .clamp(0.2, 1.0);
    // Center the (possibly down-scaled) graph. dx/dy may be negative when the
    // scaled graph is larger than the viewport — that's correct centering; don't
    // clamp it (clamping mis-aligns large graphs).
    final dx = (viewport.width - size.width * scale) / 2;
    final dy = (viewport.height - size.height * scale) / 2;
    // viewport = scale * child + translate. Scale on the diagonal, translation
    // in column 3 (translate is not itself scaled, which is what we want).
    _transform.value = Matrix4.identity()
      ..setEntry(0, 0, scale)
      ..setEntry(1, 1, scale)
      ..setEntry(2, 2, scale)
      ..setEntry(0, 3, dx)
      ..setEntry(1, 3, dy);
    _fitted = true;
  }

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final tasks = widget.vm.tasks;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    if (tasks.isEmpty) {
      return Center(
        child: Text(s.noTasksYet, style: theme.textTheme.bodyLarge),
      );
    }

    // Re-arm fit-to-view when the task set changes (add/remove shifts the layout).
    final signature = Object.hashAll(tasks.map((t) => t.id));
    if (signature != _fitSignature) {
      _fitSignature = signature;
      _fitted = false;
    }

    final byId = {for (final t in tasks) t.id: t};

    // Split into connected (part of at least one dependency edge) and isolated
    // (degree 0). graphview's Sugiyama parks edgeless nodes at (0,0) where they
    // overlap, so isolated tasks are rendered in their own "Unlinked" strip
    // instead of inside the DAG — each shows as its own standalone node.
    final connectedIds = <String>{};
    for (final t in tasks) {
      for (final depId in t.dependsOn) {
        if (byId.containsKey(depId)) {
          connectedIds.add(t.id);
          connectedIds.add(depId);
        }
      }
    }
    final connected = [for (final t in tasks) if (connectedIds.contains(t.id)) t];
    final isolated = [for (final t in tasks) if (!connectedIds.contains(t.id)) t];

    final graph = Graph();
    for (final t in connected) {
      graph.addNode(Node.Id(t.id));
    }
    for (final t in connected) {
      for (final depId in t.dependsOn) {
        if (byId.containsKey(depId)) {
          graph.addEdge(Node.Id(depId), Node.Id(t.id));
        }
      }
    }

    final configuration = SugiyamaConfiguration()
      ..orientation = SugiyamaConfiguration.ORIENTATION_TOP_BOTTOM
      // Tighter within a layer, more breathing room between layers — shortens the
      // long diagonal sweeps and lines siblings up neatly.
      ..nodeSeparation = 24
      ..levelSeparation = 90
      // Shorter, gentler bends than before (was 16) so edges read as quick
      // connectors, not big arcs.
      ..bendPointShape = CurvedBendPointShape(curveLength: 8)
      ..addTriangleToEdge = true;

    // Softer, thinner themed edge so the nodes (not the lines) carry the eye.
    final edgePaint = Paint()
      ..color = scheme.primary.withValues(alpha: 0.4)
      ..strokeWidth = 1.8
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..style = PaintingStyle.stroke;

    return LayoutBuilder(
      builder: (context, constraints) {
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => _maybeFit(constraints.biggest),
        );
        return Stack(
          children: [
            Positioned.fill(
              child: InteractiveViewer(
                transformationController: _transform,
                constrained: false,
                // Infinite boundary = free panning in every direction. A finite
                // margin clamps the pan after the initial fit (you couldn't drag
                // past it).
                boundaryMargin: const EdgeInsets.all(double.infinity),
                minScale: 0.1,
                maxScale: 4,
                child: Column(
                  key: _graphKey,
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Standalone (unlinked) tasks: their own row, always visible.
                    if (isolated.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.all(AppDimens.spacingSm),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              s.unlinked.toUpperCase(),
                              style: theme.textTheme.labelMedium?.copyWith(
                                color: scheme.primary,
                                fontWeight: FontWeight.w700,
                                letterSpacing: 0.8,
                              ),
                            ),
                            const SizedBox(height: AppDimens.spacingSm),
                            Row(
                              mainAxisSize: MainAxisSize.min,
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                for (final t in isolated)
                                  Padding(
                                    padding: const EdgeInsets.only(
                                      right: AppDimens.spacingMd,
                                    ),
                                    child: _TaskNode(
                                      task: t,
                                      statusLabel: _statusLabel(s, t.status),
                                      isLinkSource: t.id == _linkSource,
                                      onTap: () => _onNodeTap(t),
                                      onLongPressStart: (d) =>
                                          _showNodeMenu(t, d.globalPosition),
                                    ),
                                  ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    if (connected.isNotEmpty)
                      GraphView(
                        graph: graph,
                        algorithm: SugiyamaAlgorithm(configuration),
                        paint: edgePaint,
                        builder: (Node node) {
                          final task = byId[node.key!.value];
                          if (task == null) return const SizedBox.shrink();
                          return _TaskNode(
                            task: task,
                            statusLabel: _statusLabel(s, task.status),
                            isLinkSource: task.id == _linkSource,
                            onTap: () => _onNodeTap(task),
                            onLongPressStart: (d) =>
                                _showNodeMenu(task, d.globalPosition),
                          );
                        },
                      ),
                  ],
                ),
              ),
            ),
            // Status legend, pinned (doesn't pan with the canvas). Kept top-RIGHT
            // so it never hides isolated nodes, which graphview parks at (0,0).
            Positioned(
              right: AppDimens.spacingSm,
              top: AppDimens.spacingSm,
              child: _StatusLegend(strings: s),
            ),
            // Connect-mode banner.
            if (_linkSource != null)
              Positioned(
                top: AppDimens.spacingSm,
                left: 0,
                right: 0,
                child: Center(child: _ConnectBanner(
                  sourceTitle: (byId[_linkSource]?.title ?? ''),
                  onCancel: () => setState(() => _linkSource = null),
                )),
              ),
            // Add-node button.
            Positioned(
              right: AppDimens.spacingMd,
              bottom: AppDimens.spacingMd,
              child: FloatingActionButton.small(
                heroTag: 'task-graph-add-node-fab',
                onPressed: _addNodeDialog,
                tooltip: s.addTaskTooltip,
                child: const Icon(Icons.add),
              ),
            ),
          ],
        );
      },
    );
  }
}

// Top banner shown while in connect mode.
class _ConnectBanner extends StatelessWidget {
  const _ConnectBanner({required this.sourceTitle, required this.onCancel});
  final String sourceTitle;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Material(
      color: scheme.inverseSurface,
      borderRadius: BorderRadius.circular(AppDimens.radiusLg),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppDimens.spacingMd,
          AppDimens.spacingXs,
          AppDimens.spacingSm,
          AppDimens.spacingXs,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: Text(
                context.l10n.linkTargetPrompt(sourceTitle),
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: scheme.onInverseSurface),
              ),
            ),
            const SizedBox(width: AppDimens.spacingSm),
            TextButton(onPressed: onCancel, child: Text(context.l10n.cancel)),
          ],
        ),
      ),
    );
  }
}

// Localized status label — shared by the node + legend.
String _statusLabel(AppStrings s, TaskStatus st) {
  return switch (st) {
    TaskStatus.todo => s.statusTodo,
    TaskStatus.inProgress => s.statusInProgress,
    TaskStatus.done => s.statusDone,
  };
}

// (bg, fg, accent) palette for a task status — shared by the node + legend.
(Color, Color, Color) _statusColors(ColorScheme scheme, TaskStatus status) {
  return switch (status) {
    TaskStatus.todo => (
        scheme.surfaceContainerHighest,
        scheme.onSurface,
        scheme.outline,
      ),
    TaskStatus.inProgress => (
        scheme.primaryContainer,
        scheme.onPrimaryContainer,
        scheme.primary,
      ),
    TaskStatus.done => (
        scheme.secondaryContainer,
        scheme.onSecondaryContainer,
        scheme.secondary,
      ),
  };
}

// Small pinned legend mapping the status dot colors.
class _StatusLegend extends StatelessWidget {
  const _StatusLegend({required this.strings});
  final AppStrings strings;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppDimens.spacingSm,
        vertical: AppDimens.spacingXs,
      ),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHigh.withValues(alpha: 0.92),
        borderRadius: BorderRadius.circular(AppDimens.radiusSm),
        border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.6)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final status in TaskStatus.values) ...[
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                color: _statusColors(scheme, status).$3,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: AppDimens.spacingXs),
            Text(_statusLabel(strings, status),
                style: theme.textTheme.labelSmall),
            const SizedBox(width: AppDimens.spacingSm),
          ],
        ],
      ),
    );
  }
}

class _TaskNode extends StatelessWidget {
  const _TaskNode({
    required this.task,
    required this.statusLabel,
    required this.onTap,
    required this.onLongPressStart,
    this.isLinkSource = false,
  });

  final Task task;
  final String statusLabel;
  final VoidCallback onTap;
  final void Function(LongPressStartDetails) onLongPressStart;
  final bool isLinkSource;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final (bg, fg, accent) = _statusColors(scheme, task.status);

    return GestureDetector(
      onTap: onTap,
      onLongPressStart: onLongPressStart,
      // Uniform node footprint so every layer lines up cleanly regardless of
      // 1- vs 2-line titles.
      child: Container(
        width: 176,
        height: 76,
        padding: const EdgeInsets.symmetric(
          horizontal: AppDimens.spacingMd,
          vertical: AppDimens.spacingSm,
        ),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(AppDimens.radiusMd),
          border: Border.all(
            color: isLinkSource
                ? scheme.primary
                : scheme.outlineVariant.withValues(alpha: 0.6),
            width: isLinkSource ? 2 : 1,
          ),
          boxShadow: [
            BoxShadow(
              color: scheme.shadow.withValues(alpha: 0.10),
              blurRadius: 6,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(color: accent, shape: BoxShape.circle),
                ),
                const SizedBox(width: AppDimens.spacingSm),
                Expanded(
                  child: Text(
                    statusLabel,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: fg.withValues(alpha: 0.75),
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.3,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppDimens.spacingXs + 2),
            Expanded(
              child: Text(
                task.title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodyMedium
                    ?.copyWith(color: fg, fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
