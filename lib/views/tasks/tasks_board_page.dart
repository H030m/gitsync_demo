import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_strings.dart';
import '../../models/task.dart';
import '../../services/navigation.dart';
import '../../theme/app_dimens.dart';
import '../../theme/app_motion.dart';
import '../../widgets/section_card.dart';
import '../../view_models/members_vm.dart';
import '../../view_models/tasks_board_vm.dart';
import '../../widgets/staggered_entry.dart';
import 'widgets/status_picker.dart';
import 'widgets/task_graph_tab.dart';

// TasksBoardPage — kanban (看板) + dependency-graph (關聯圖) tabs.
// Faithful restyle of the prototype `tasks/TasksBoard.tsx`: tonal column headers,
// count chips, rich cards (摘要 / 負責人 / 交接 / 依賴) and long-press
// drag-and-drop between columns. Responsive: wide viewports fill the page with
// three Expanded columns; narrow ones use a TickTick-style vertical list of
// collapsible status sections (tap a row's circle to mark it done, tap the row
// to open details). See tasks 06-06 and 06-13.

// Layout tuning. A column needs ~200dp for the card content to breathe; the
// board switches to fill mode once three of those + gaps + padding fit.
const double _kMinColumnWidth = 200;
const double _kColumnGap = AppDimens.spacingSm + 2;
const double _kBoardHPad = AppDimens.spacingSm + AppDimens.spacingXs;

class TasksBoardPage extends StatelessWidget {
  const TasksBoardPage({super.key, required this.repoId});
  final String repoId;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          leading: IconButton(
            icon: const Icon(Icons.arrow_back),
            tooltip: s.backToRepos,
            onPressed: () => Provider.of<NavigationService>(
              context,
              listen: false,
            ).goRepos(),
          ),
          title: Text(s.tasksTitle),
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(kTextTabBarHeight + 1),
            child: Column(
              children: [
                const Divider(height: 1),
                TabBar(
                  tabs: [
                    Tab(text: s.boardTab),
                    Tab(text: s.graphTab),
                  ],
                ),
              ],
            ),
          ),
        ),
        floatingActionButton: FloatingActionButton(
          heroTag: 'tasks-board-add-fab',
          tooltip: s.addTaskTitle,
          onPressed: () => Provider.of<NavigationService>(
            context,
            listen: false,
          ).goAddTodo(repoId),
          child: const Icon(Icons.add),
        ),
        body: Consumer<TasksBoardViewModel>(
          builder: (ctx, vm, _) {
            if (vm.loading) {
              return const Center(child: CircularProgressIndicator());
            }
            return TabBarView(
              children: [
                _BoardTab(vm: vm),
                TaskGraphTab(vm: vm),
              ],
            );
          },
        ),
      ),
    );
  }
}

// Per-column visual tokens. Tints are derived from the active ColorScheme via an
// exhaustive switch on TaskStatus (no hardcoded hexes) so light + dark both read
// as a graded primary family: header background (tonal), accent (label + chip),
// and the column label.
class _ColumnTheme {
  const _ColumnTheme({
    required this.label,
    required this.tonal,
    required this.accent,
  });
  final String label;
  final Color tonal;
  final Color accent;

  static _ColumnTheme of(ColorScheme scheme, AppStrings s, TaskStatus status) {
    return switch (status) {
      TaskStatus.todo => _ColumnTheme(
        label: s.statusTodo,
        tonal: scheme.surfaceContainerHighest,
        accent: scheme.primary.withValues(alpha: 0.55),
      ),
      TaskStatus.inProgress => _ColumnTheme(
        label: s.statusInProgress,
        tonal: scheme.primaryContainer,
        accent: scheme.primary,
      ),
      TaskStatus.done => _ColumnTheme(
        label: s.statusDone,
        tonal: scheme.secondaryContainer,
        accent: scheme.secondary,
      ),
    };
  }
}

class _BoardTab extends StatelessWidget {
  const _BoardTab({required this.vm});
  final TasksBoardViewModel vm;

  @override
  Widget build(BuildContext context) {
    final allEmpty = vm.tasks.isEmpty;
    if (allEmpty) return const _EmptyBoard();

    const columns = [TaskStatus.todo, TaskStatus.inProgress, TaskStatus.done];

    return LayoutBuilder(
      builder: (context, constraints) {
        // Width needed for three real columns side by side (padding + 2 gaps).
        const fillThreshold =
            3 * _kMinColumnWidth + 2 * _kColumnGap + 2 * _kBoardHPad;
        final fill = constraints.maxWidth >= fillThreshold;

        if (fill) {
          // Desktop/tablet: three Expanded columns fill the page width.
          return Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: _kBoardHPad,
              vertical: AppDimens.spacingSm,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (var i = 0; i < columns.length; i++) ...[
                  if (i > 0) const SizedBox(width: _kColumnGap),
                  Expanded(
                    child: _BoardColumn(
                      vm: vm,
                      status: columns[i],
                      tasks: _tasksFor(vm, columns[i]),
                    ),
                  ),
                ],
              ],
            ),
          );
        }

        // Phone: vertical list of collapsible status sections (TickTick-style).
        return _SectionedBoardList(vm: vm);
      },
    );
  }

  static List<Task> _tasksFor(TasksBoardViewModel vm, TaskStatus status) =>
      switch (status) {
        TaskStatus.todo => vm.todo,
        TaskStatus.inProgress => vm.inProgress,
        TaskStatus.done => vm.done,
      };
}

// Narrow-layout board: the three status groups stacked vertically as
// collapsible sections that scroll together as one list. Expansion state is
// page-local (intentionally not persisted): todo + in-progress start expanded,
// done starts collapsed.
class _SectionedBoardList extends StatefulWidget {
  const _SectionedBoardList({required this.vm});
  final TasksBoardViewModel vm;

  @override
  State<_SectionedBoardList> createState() => _SectionedBoardListState();
}

class _SectionedBoardListState extends State<_SectionedBoardList> {
  final Map<TaskStatus, bool> _expanded = {
    TaskStatus.todo: true,
    TaskStatus.inProgress: true,
    TaskStatus.done: false,
  };

  @override
  Widget build(BuildContext context) {
    const sections = [TaskStatus.todo, TaskStatus.inProgress, TaskStatus.done];
    return ListView(
      padding: const EdgeInsets.symmetric(
        horizontal: _kBoardHPad,
        vertical: AppDimens.spacingSm,
      ),
      children: [
        for (var i = 0; i < sections.length; i++) ...[
          if (i > 0) const SizedBox(height: AppDimens.spacingSm),
          _BoardSection(
            vm: widget.vm,
            status: sections[i],
            tasks: _BoardTab._tasksFor(widget.vm, sections[i]),
            expanded: _expanded[sections[i]]!,
            onToggle: () => setState(
              () => _expanded[sections[i]] = !_expanded[sections[i]]!,
            ),
          ),
        ],
      ],
    );
  }
}

// One collapsible status section: a tappable tonal header (label + count chip +
// rotating chevron) over the task rows. Reuses the kanban column's status
// tokens so light/dark stay consistent with the wide layout.
class _BoardSection extends StatelessWidget {
  const _BoardSection({
    required this.vm,
    required this.status,
    required this.tasks,
    required this.expanded,
    required this.onToggle,
  });

  final TasksBoardViewModel vm;
  final TaskStatus status;
  final List<Task> tasks;
  final bool expanded;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final s = context.l10n;
    final colTheme = _ColumnTheme.of(scheme, s, status);

    return Material(
      color: scheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(AppDimens.radiusLg),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Material(
            color: colTheme.tonal,
            child: InkWell(
              onTap: onToggle,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppDimens.spacingSm + AppDimens.spacingXs,
                  vertical: AppDimens.spacingSm,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        colTheme.label,
                        style: theme.textTheme.titleSmall?.copyWith(
                          color: colTheme.accent,
                          fontWeight: FontWeight.w700,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    _CountChip(count: tasks.length, accent: colTheme.accent),
                    const SizedBox(width: AppDimens.spacingSm),
                    AnimatedRotation(
                      turns: expanded ? 0.5 : 0,
                      duration: AppMotion.short,
                      curve: AppMotion.standard,
                      child: Icon(
                        Icons.expand_more,
                        size: 20,
                        color: colTheme.accent,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          AnimatedSize(
            duration: AppMotion.short,
            curve: AppMotion.standard,
            alignment: Alignment.topCenter,
            child: !expanded
                ? const SizedBox.shrink()
                : tasks.isEmpty
                    ? Padding(
                        padding: const EdgeInsets.all(AppDimens.spacingMd),
                        child: Center(
                          child: Text(
                            '—',
                            style: theme.textTheme.bodyLarge?.copyWith(
                              color: scheme.onSurfaceVariant,
                            ),
                          ),
                        ),
                      )
                    : Padding(
                        padding: const EdgeInsets.symmetric(
                          vertical: AppDimens.spacingXs,
                        ),
                        child: Column(
                          children: [
                            // Per-tile fade + slide-up entrance, staggered by
                            // index (capped inside StaggeredEntry). Keyed by
                            // taskId so a status change / re-order doesn't
                            // replay the tween on still-mounted rows.
                            for (var i = 0; i < tasks.length; i++)
                              StaggeredEntry(
                                key: ValueKey('row-${tasks[i].id}'),
                                index: i,
                                child: _SectionTaskRow(
                                  vm: vm,
                                  task: tasks[i],
                                  accent: colTheme.accent,
                                ),
                              ),
                          ],
                        ),
                      ),
          ),
        ],
      ),
    );
  }
}

// One task row in a section: leading status circle (tap = mark done), title,
// trailing assignee avatar. Tapping the row opens TaskDetails; long-pressing
// it opens the shared status picker for an arbitrary transition. Done rows
// show a filled check circle whose tap is absorbed (no-op) instead of
// navigating.
class _SectionTaskRow extends StatelessWidget {
  const _SectionTaskRow({
    required this.vm,
    required this.task,
    required this.accent,
  });

  final TasksBoardViewModel vm;
  final Task task;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final isDone = task.status == TaskStatus.done;

    return InkWell(
      onTap: () => Provider.of<NavigationService>(
        context,
        listen: false,
      ).goTaskDetails(vm.repoId, task.id),
      onLongPress: () => _pickStatus(context),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppDimens.spacingSm + AppDimens.spacingXs,
          vertical: AppDimens.spacingSm,
        ),
        child: Row(
          children: [
            InkResponse(
              radius: 18,
              // Done rows absorb the tap so the circle stays a no-op instead
              // of falling through to the row's navigation.
              onTap: isDone ? () {} : () => _markDone(context),
              child: Icon(
                isDone ? Icons.check_circle : Icons.radio_button_unchecked,
                size: 22,
                color: isDone ? accent : scheme.outline,
              ),
            ),
            const SizedBox(width: AppDimens.spacingSm + AppDimens.spacingXs),
            Expanded(
              child: Text(
                task.title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: scheme.onSurface,
                  fontWeight: FontWeight.w600,
                  height: 1.25,
                ),
              ),
            ),
            const SizedBox(width: AppDimens.spacingSm),
            _AssigneeCircle(assigneeId: task.assigneeId, accent: accent),
          ],
        ),
      ),
    );
  }

  // Long-press: shared three-state picker → write the chosen status. Picking
  // the current status (or dismissing) is a no-op. Same async-gap discipline
  // as [_markDone]: capture messenger + strings BEFORE the awaits (stateless
  // row, no `mounted`).
  Future<void> _pickStatus(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final s = context.l10n;
    final picked = await showStatusPicker(context, current: task.status);
    if (picked == null || picked == task.status) return;
    try {
      await vm.updateStatus(task.id, picked);
    } catch (e) {
      messenger
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(s.updateStatusFailed(e))));
    }
  }

  // Stateless row: capture the messenger + strings BEFORE the await so no
  // BuildContext is used after the async gap (there is no `mounted` here).
  Future<void> _markDone(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final s = context.l10n;
    try {
      await vm.updateStatus(task.id, TaskStatus.done);
    } catch (e) {
      messenger
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(s.updateStatusFailed(e))));
    }
  }
}

// Centered card shown when every column is empty — mirrors the prototype copy.
class _EmptyBoard extends StatelessWidget {
  const _EmptyBoard();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final s = context.l10n;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppDimens.spacingLg),
        child: SectionCard(
          padding: const EdgeInsets.all(AppDimens.spacingLg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerHighest,
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  Icons.add,
                  size: 32,
                  color: scheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AppDimens.spacingMd),
              Text(
                s.emptyBoardTitle,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyLarge?.copyWith(
                  color: scheme.onSurface,
                ),
              ),
              const SizedBox(height: AppDimens.spacingXs),
              Text(
                s.emptyBoardMsg,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// One kanban column: a tonal header (label + count chip) over a
// secondary-background card list. Width is set by the parent (Expanded in fill
// mode, fixed SizedBox in scroll mode). The body is a DragTarget that accepts
// cards from other columns and writes the new status through the ViewModel.
class _BoardColumn extends StatefulWidget {
  const _BoardColumn({
    required this.vm,
    required this.status,
    required this.tasks,
  });

  final TasksBoardViewModel vm;
  final TaskStatus status;
  final List<Task> tasks;

  @override
  State<_BoardColumn> createState() => _BoardColumnState();
}

class _BoardColumnState extends State<_BoardColumn> {
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final s = context.l10n;
    final colTheme = _ColumnTheme.of(scheme, s, widget.status);

    return DragTarget<Task>(
      onWillAcceptWithDetails: (details) =>
          details.data.status != widget.status,
      onAcceptWithDetails: (details) => _accept(details.data),
      builder: (context, candidate, rejected) {
        final hovering = candidate.isNotEmpty;
        return Container(
          decoration: BoxDecoration(
            color: scheme.surfaceContainerLow,
            borderRadius: BorderRadius.circular(AppDimens.radiusLg),
            border: Border.all(
              color: hovering ? colTheme.accent : Colors.transparent,
              width: 2,
            ),
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Tonal header: accent label + count chip.
              Container(
                color: colTheme.tonal,
                padding: const EdgeInsets.symmetric(
                  horizontal: AppDimens.spacingSm + AppDimens.spacingXs,
                  vertical: AppDimens.spacingSm,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        colTheme.label,
                        style: theme.textTheme.titleSmall?.copyWith(
                          color: colTheme.accent,
                          fontWeight: FontWeight.w700,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    _CountChip(
                      count: widget.tasks.length,
                      accent: colTheme.accent,
                    ),
                  ],
                ),
              ),
              // Card list (secondary background), tinted while hovering. Expands
              // to fill the column height and scrolls when there are many tasks.
              Expanded(
                child: Container(
                  color: hovering
                      ? colTheme.accent.withValues(alpha: 0.08)
                      : Colors.transparent,
                  padding: const EdgeInsets.all(AppDimens.spacingSm),
                  child: widget.tasks.isEmpty
                      ? Center(
                          child: Text(
                            '—',
                            style: theme.textTheme.bodyLarge?.copyWith(
                              color: scheme.onSurfaceVariant,
                            ),
                          ),
                        )
                      : ListView.builder(
                          padding: EdgeInsets.zero,
                          itemCount: widget.tasks.length,
                          itemBuilder: (_, i) => Padding(
                            padding: const EdgeInsets.only(
                              bottom: AppDimens.spacingSm,
                            ),
                            // Stagger card entrance keyed by taskId so a
                            // status-change re-order doesn't replay the tween.
                            child: StaggeredEntry(
                              key: ValueKey('card-${widget.tasks[i].id}'),
                              index: i,
                              child: _TaskCard(
                                vm: widget.vm,
                                task: widget.tasks[i],
                                accent: colTheme.accent,
                              ),
                            ),
                          ),
                        ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _accept(Task task) async {
    final s = context.l10n;
    try {
      await widget.vm.updateStatus(task.id, widget.status);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(s.updateStatusFailed(e))));
    }
  }
}

// Small pill showing the number of cards in a column: accent @ ~20% bg + accent
// text, per the prototype.
class _CountChip extends StatelessWidget {
  const _CountChip({required this.count, required this.accent});
  final int count;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppDimens.spacingSm,
        vertical: 2,
      ),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.2),
        borderRadius: BorderRadius.circular(AppDimens.radiusLg),
      ),
      child: Text(
        '$count',
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: accent,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

// A draggable rich task card. Long-press to drag between columns; tap to open
// TaskDetails. The drag feedback is constrained to the column's inner width
// (via LayoutBuilder) so the ghost doesn't blow up to an unbounded size.
class _TaskCard extends StatelessWidget {
  const _TaskCard({required this.vm, required this.task, required this.accent});

  final TasksBoardViewModel vm;
  final Task task;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    final card = _CardBody(task: task, accent: accent);
    return LayoutBuilder(
      builder: (context, constraints) {
        // The card is laid out at the column's inner width; reuse it for the
        // drag ghost so it stays bounded in both layout modes.
        final width = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : _kMinColumnWidth;
        return LongPressDraggable<Task>(
          data: task,
          feedback: Material(
            color: Colors.transparent,
            child: Opacity(
              opacity: 0.9,
              child: SizedBox(
                width: width,
                child: _CardBody(task: task, accent: accent, elevated: true),
              ),
            ),
          ),
          childWhenDragging: Opacity(opacity: 0.4, child: card),
          child: InkWell(
            borderRadius: BorderRadius.circular(AppDimens.radiusMd),
            onTap: () => Provider.of<NavigationService>(
              context,
              listen: false,
            ).goTaskDetails(vm.repoId, task.id),
            child: card,
          ),
        );
      },
    );
  }
}

class _CardBody extends StatelessWidget {
  const _CardBody({
    required this.task,
    required this.accent,
    this.elevated = false,
  });

  final Task task;
  final Color accent;
  final bool elevated;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Container(
      padding: const EdgeInsets.all(AppDimens.spacingSm + 2),
      decoration: BoxDecoration(
        color: theme.brightness == Brightness.light
            ? const Color(0xFFFFFFFF)
            : scheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(AppDimens.radiusMd),
        border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.4)),
        boxShadow: [
          BoxShadow(
            color: scheme.shadow.withValues(alpha: elevated ? 0.22 : 0.06),
            blurRadius: elevated ? 10 : 6,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Title — 工作標題.
          Text(
            task.title,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: scheme.onSurface,
              fontWeight: FontWeight.w600,
              height: 1.25,
            ),
          ),
          const SizedBox(height: AppDimens.spacingSm),
          // Bottom row: left = 依賴/交接 indicators, right = 負責人 chip.
          Row(
            children: [
              const Spacer(),
              _AssigneeCircle(assigneeId: task.assigneeId, accent: accent),
            ],
          ),
        ],
      ),
    );
  }
}

// Bottom-right initial circle: accent-tinted with the assignee's first character
// when assigned, otherwise a plain grey circle (unassigned).
class _AssigneeCircle extends StatelessWidget {
  const _AssigneeCircle({required this.assigneeId, required this.accent});
  final String? assigneeId;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final id = assigneeId;
    if (id == null || id.isEmpty) {
      return Container(
        width: 20,
        height: 20,
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest,
          shape: BoxShape.circle,
        ),
      );
    }
    // Resolve the assignee's GitHub profile (cached in MembersViewModel) to show
    // their avatar; fall back to the githubLogin/name initial (then uid).
    final profile = context.watch<MembersViewModel>().profileFor(id);
    final url = profile?.avatarUrl;
    final seed = (profile?.githubLogin.isNotEmpty ?? false)
        ? profile!.githubLogin
        : (profile?.name.isNotEmpty ?? false)
            ? profile!.name
            : id;
    return CircleAvatar(
      radius: 10,
      backgroundColor: accent.withValues(alpha: 0.2),
      foregroundImage:
          (url != null && url.isNotEmpty) ? NetworkImage(url) : null,
      child: Text(
        seed.characters.first.toUpperCase(),
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: accent,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

// [feat] 任務看板：依狀態分欄（TODO / 進行中 / 完成），支援拖拉換狀態與即時同步。

// [feat] 任務看板：依狀態分欄（TODO / 進行中 / 完成），支援拖拉換狀態與即時同步。
