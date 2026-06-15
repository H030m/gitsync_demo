import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_strings.dart';
import '../../models/app_user.dart';
import '../../models/member.dart';
import '../../models/sub_task.dart';
import '../../models/task.dart';
import '../../services/authentication.dart';
import '../../services/functions_service.dart';
import '../../services/navigation.dart';
import '../../theme/app_dimens.dart';
import '../../view_models/members_vm.dart';
import '../../view_models/tasks_board_vm.dart';

// How a task gets created: by hand (one task) or by AI breakdown (spec → list).
enum _AddMode { manual, ai }

// ---------------------------------------------------------------------------
// Quick-add bottom sheet (manual mode only). Opened from the FAB on the
// TasksBoardPage. For the AI breakdown flow the full AddTodoPage is used.
// ---------------------------------------------------------------------------

/// Shows the quick-add bottom sheet for manual task creation. Returns true if
/// a task was added, false/null otherwise.
Future<bool?> showAddTaskSheet(BuildContext context, String repoId) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => _AddTaskSheet(repoId: repoId),
  );
}

class _AddTaskSheet extends StatefulWidget {
  const _AddTaskSheet({required this.repoId});
  final String repoId;

  @override
  State<_AddTaskSheet> createState() => _AddTaskSheetState();
}

class _AddTaskSheetState extends State<_AddTaskSheet> {
  final _titleCtrl = TextEditingController();
  final _descCtrl = TextEditingController();
  String? _assigneeId;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _titleCtrl.dispose();
    _descCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final title = _titleCtrl.text.trim();
    if (title.isEmpty || _busy) return;
    final vm = Provider.of<TasksBoardViewModel>(context, listen: false);
    final uid =
        Provider.of<AuthenticationService>(context, listen: false).currentUid;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await vm.addTask(Task(
        id: '',
        title: title,
        description: _descCtrl.text.trim(),
        assigneeId: _assigneeId,
        createdBy: uid ?? '',
      ));
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = context.l10n.couldNotAddTask);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppDimens.spacingMd,
        AppDimens.spacingMd,
        AppDimens.spacingMd,
        MediaQuery.of(context).viewInsets.bottom + AppDimens.spacingMd,
      ),
      child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Drag handle
            Center(
              child: Container(
                width: 32,
                height: 4,
                margin: const EdgeInsets.only(bottom: AppDimens.spacingMd),
                decoration: BoxDecoration(
                  color: scheme.onSurfaceVariant.withValues(alpha: 0.4),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            Row(
              children: [
                Text(
                  s.addTaskTitle,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                TextButton.icon(
                  onPressed: () {
                    Navigator.of(context).pop();
                    Provider.of<NavigationService>(context, listen: false)
                        .goAddTodo(widget.repoId);
                  },
                  icon: const Icon(Icons.auto_awesome, size: 18),
                  label: Text(s.aiBreakdown),
                ),
              ],
            ),
            const SizedBox(height: AppDimens.spacingMd),
            TextField(
              controller: _titleCtrl,
              autofocus: true,
              textInputAction: TextInputAction.next,
              decoration: InputDecoration(
                labelText: s.taskTitleLabel,
                border: const OutlineInputBorder(),
              ),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: AppDimens.spacingSm),
            TextField(
              controller: _descCtrl,
              minLines: 2,
              maxLines: 4,
              decoration: InputDecoration(
                labelText: s.descriptionOptional,
                border: const OutlineInputBorder(),
                alignLabelWithHint: true,
              ),
            ),
            const SizedBox(height: AppDimens.spacingSm),
            // Assignee picker
            Consumer<MembersViewModel>(
              builder: (ctx, membersVm, _) {
                final members = membersVm.members;
                if (members.isEmpty) return const SizedBox.shrink();
                return _AssigneePicker(
                  members: members,
                  profileFor: membersVm.profileFor,
                  selectedId: _assigneeId,
                  onChanged: (id) => setState(() => _assigneeId = id),
                );
              },
            ),
            const SizedBox(height: AppDimens.spacingMd),
            FilledButton.icon(
              onPressed:
                  _busy || _titleCtrl.text.trim().isEmpty ? null : _submit,
              icon: _busy
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.add),
              label: Text(_busy ? s.addingTask : s.addTaskTitle),
            ),
            if (_error != null) ...[
              const SizedBox(height: AppDimens.spacingSm),
              Text(_error!, style: TextStyle(color: scheme.error)),
            ],
          ],
        ),
    );
  }
}

// ---------------------------------------------------------------------------
// Full-page Add Task (kept for AI breakdown flow).
// ---------------------------------------------------------------------------

class AddTodoPage extends StatefulWidget {
  const AddTodoPage({super.key, required this.repoId});
  final String repoId;

  @override
  State<AddTodoPage> createState() => _AddTodoPageState();
}

class _AddTodoPageState extends State<AddTodoPage> {
  _AddMode _mode = _AddMode.ai;

  // Manual mode.
  final _titleCtrl = TextEditingController();
  final _descCtrl = TextEditingController();
  String? _assigneeId;

  // AI mode.
  int _step = 0;
  String _goal = '';
  List<SubTask> _subtasks = [];

  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _titleCtrl.dispose();
    _descCtrl.dispose();
    super.dispose();
  }

  Future<void> _addManual() async {
    final title = _titleCtrl.text.trim();
    if (title.isEmpty || _busy) return;
    final vm = Provider.of<TasksBoardViewModel>(context, listen: false);
    final nav = Provider.of<NavigationService>(context, listen: false);
    final uid =
        Provider.of<AuthenticationService>(context, listen: false).currentUid;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await vm.addTask(Task(
        id: '',
        title: title,
        description: _descCtrl.text.trim(),
        assigneeId: _assigneeId,
        createdBy: uid ?? '',
      ));
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(context.l10n.taskAddedWithTitle(title))),
      );
      nav.goTasks(widget.repoId);
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = context.l10n.couldNotAddTask);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _runBreakdown() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final fn = Provider.of<FunctionsService>(context, listen: false);
      // W6: generate the tasks in the app's current language.
      final subs = await fn.breakdownTask(
        repoId: widget.repoId,
        goal: _goal,
        language: context.l10n.backendLanguage,
      );
      if (!mounted) return;
      setState(() {
        _subtasks = subs.toList();
        _step = 1;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = context.l10n.couldNotBreakdown);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _removeSubtask(int index) {
    setState(() => _subtasks.removeAt(index));
  }

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(s.addTaskTitle)),
      body: Padding(
        padding: const EdgeInsets.all(AppDimens.spacingMd),
        child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (!(_mode == _AddMode.ai && _step == 1)) ...[
                Center(
                  child: SegmentedButton<_AddMode>(
                    segments: [
                      ButtonSegment(
                        value: _AddMode.ai,
                        icon: const Icon(Icons.auto_awesome),
                        label: Text(s.aiBreakdown),
                      ),
                      ButtonSegment(
                        value: _AddMode.manual,
                        icon: const Icon(Icons.edit_outlined),
                        label: Text(s.manual),
                      ),
                    ],
                    selected: {_mode},
                    onSelectionChanged: _busy
                        ? null
                        : (s) => setState(() {
                              _mode = s.first;
                              _error = null;
                            }),
                  ),
                ),
                const SizedBox(height: AppDimens.spacingMd),
              ],
              Expanded(
                child: switch (_mode) {
                  _AddMode.manual => _manualView(),
                  _AddMode.ai => _step == 0 ? _inputStep() : _confirmStep(),
                },
              ),
            ],
          ),
        ),
    );
  }

  Widget _manualView() {
    final s = context.l10n;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: _titleCtrl,
          autofocus: true,
          textInputAction: TextInputAction.next,
          decoration: InputDecoration(
            labelText: s.taskTitleLabel,
            border: const OutlineInputBorder(),
          ),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: AppDimens.spacingMd),
        TextField(
          controller: _descCtrl,
          minLines: 3,
          maxLines: 6,
          decoration: InputDecoration(
            labelText: s.descriptionOptional,
            border: const OutlineInputBorder(),
            alignLabelWithHint: true,
          ),
        ),
        const SizedBox(height: AppDimens.spacingSm),
        // Assignee picker
        Consumer<MembersViewModel>(
          builder: (ctx, membersVm, _) {
            final members = membersVm.members;
            if (members.isEmpty) return const SizedBox.shrink();
            return Padding(
              padding: const EdgeInsets.only(bottom: AppDimens.spacingSm),
              child: _AssigneePicker(
                members: members,
                profileFor: membersVm.profileFor,
                selectedId: _assigneeId,
                onChanged: (id) => setState(() => _assigneeId = id),
              ),
            );
          },
        ),
        const SizedBox(height: AppDimens.spacingSm),
        FilledButton.icon(
          onPressed:
              _busy || _titleCtrl.text.trim().isEmpty ? null : _addManual,
          icon: _busy
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.add),
          label: Text(_busy ? s.addingTask : s.addTaskTitle),
        ),
        if (_error != null) ...[
          const SizedBox(height: AppDimens.spacingMd),
          Text(_error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error)),
        ],
      ],
    );
  }

  Widget _inputStep() {
    final s = context.l10n;
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // AI mode hint
        Text(
          s.aiBreakdownHint,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: AppDimens.spacingSm),
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 360),
          child: TextField(
            decoration: InputDecoration(
              labelText: s.projectSpec,
              hintText: s.projectSpecHint,
              border: const OutlineInputBorder(),
              alignLabelWithHint: true,
            ),
            maxLines: null,
            minLines: 10,
            keyboardType: TextInputType.multiline,
            onChanged: (v) => setState(() => _goal = v),
          ),
        ),
        const SizedBox(height: AppDimens.spacingMd),
        FilledButton.icon(
          onPressed: _busy || _goal.trim().isEmpty ? null : _runBreakdown,
          icon: const Icon(Icons.auto_awesome),
          label: Text(_busy ? s.breakingDown : s.breakDownWithAI),
        ),
        if (_error != null) ...[
          const SizedBox(height: AppDimens.spacingMd),
          Text(_error!, style: TextStyle(color: scheme.error)),
        ],
      ],
    );
  }

  Widget _confirmStep() {
    final s = context.l10n;
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                s.generatedNSubtasks(_subtasks.length),
                style: theme.textTheme.titleMedium,
              ),
            ),
            TextButton.icon(
              onPressed: _busy
                  ? null
                  : () => setState(() {
                        _step = 0;
                        _subtasks = [];
                      }),
              icon: const Icon(Icons.refresh, size: 18),
              label: Text(s.reBreakdown),
            ),
          ],
        ),
        const SizedBox(height: AppDimens.spacingSm),
        Expanded(
          child: ListView.builder(
            itemCount: _subtasks.length,
            itemBuilder: (ctx, i) {
              final sub = _subtasks[i];
              return Dismissible(
                key: ValueKey('${sub.id}-$i'),
                direction: DismissDirection.endToStart,
                background: Container(
                  alignment: Alignment.centerRight,
                  padding: const EdgeInsets.only(right: AppDimens.spacingMd),
                  color: theme.colorScheme.error,
                  child: Icon(Icons.delete, color: theme.colorScheme.onError),
                ),
                onDismissed: (_) => _removeSubtask(i),
                child: Card(
                  child: ListTile(
                    title: Text(sub.title),
                    subtitle: Text(sub.description),
                    trailing: Text(
                      '${sub.estimatedHours.toStringAsFixed(1)}h',
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        FilledButton(
          onPressed: _subtasks.isEmpty
              ? null
              : () =>
                  Provider.of<NavigationService>(context, listen: false)
                      .goTasks(widget.repoId),
          child: Text(s.done),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Shared assignee picker widget (used in both bottom sheet and full page).
// ---------------------------------------------------------------------------

class _AssigneePicker extends StatelessWidget {
  const _AssigneePicker({
    required this.members,
    required this.profileFor,
    required this.selectedId,
    required this.onChanged,
  });

  final List<Member> members;
  final AppUser? Function(String) profileFor;
  final String? selectedId;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    // Sentinel for "no assignee" since DropdownButton<String> needs a
    // non-null value to match. Mapped back to null in onChanged.
    const unassignedKey = '__unassigned__';
    return InputDecorator(
      decoration: InputDecoration(
        labelText: s.assigneeOptional,
        border: const OutlineInputBorder(),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AppDimens.spacingSm,
          vertical: AppDimens.spacingXs,
        ),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          value: selectedId ?? unassignedKey,
          isExpanded: true,
          isDense: true,
          items: [
            DropdownMenuItem(
              value: unassignedKey,
              child: Text(
                s.unassigned,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
            ),
            for (final m in members)
              DropdownMenuItem(
                value: m.userId,
                child: Text(_memberLabel(m)),
              ),
          ],
          onChanged: (v) => onChanged(v == unassignedKey ? null : v),
        ),
      ),
    );
  }

  String _memberLabel(Member m) {
    final profile = profileFor(m.userId);
    if (profile != null) {
      if (profile.githubLogin.isNotEmpty) return profile.githubLogin;
      if (profile.name.isNotEmpty) return profile.name;
    }
    return m.userId;
  }
}

// [feat] 新增任務：點擊懸浮加號 → 輸入 markdown 描述 → 由 AI 生成任務。
