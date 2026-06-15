import 'package:flutter/material.dart';

import '../../../l10n/app_strings.dart';
import '../../../models/task.dart';
import '../../../theme/app_dimens.dart';
import '../../../theme/app_motion.dart';

// Shared three-state status picker (task 06-13): one bottom sheet used by both
// status-edit entry points — the details page's status chip and the phone
// board's long-pressed section row. Lists todo / inProgress / done with the
// current status check-marked, and pops the chosen status (null = dismissed).
// Callers treat picking the current status as a no-op.
Future<TaskStatus?> showStatusPicker(
  BuildContext context, {
  required TaskStatus current,
}) {
  return showModalBottomSheet<TaskStatus>(
    context: context,
    showDragHandle: true,
    // Tune enter/exit to match the app's sheet timing (AppMotion.sheetStyle).
    // Flutter owns the controller — no caller has to host a TickerProvider.
    sheetAnimationStyle: AppMotion.sheetStyle,
    builder: (ctx) => _StatusPickerSheet(current: current),
  );
}

class _StatusPickerSheet extends StatelessWidget {
  const _StatusPickerSheet({required this.current});
  final TaskStatus current;

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
                s.changeStatusTitle,
                style: theme.textTheme.titleMedium
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
            ),
          ),
          for (final status in TaskStatus.values)
            _StatusTile(status: status, selected: status == current),
          const SizedBox(height: AppDimens.spacingSm),
        ],
      ),
    );
  }
}

class _StatusTile extends StatelessWidget {
  const _StatusTile({required this.status, required this.selected});
  final TaskStatus status;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    // Per-status tokens derived from the active ColorScheme via an exhaustive
    // switch — same palette as the board's `_ColumnTheme` and the details
    // page's `_StatusChip`, so light and dark both read consistently.
    final (label, swatchBg, swatchFg) = switch (status) {
      TaskStatus.todo => (
          s.statusTodo,
          scheme.surfaceContainerHighest,
          scheme.onSurface,
        ),
      TaskStatus.inProgress => (
          s.statusInProgress,
          scheme.primaryContainer,
          scheme.onPrimaryContainer,
        ),
      TaskStatus.done => (
          s.statusDone,
          scheme.secondaryContainer,
          scheme.onSecondaryContainer,
        ),
    };
    return ListTile(
      leading: Container(
        width: 24,
        height: 24,
        decoration: BoxDecoration(
          color: swatchBg,
          shape: BoxShape.circle,
          border: Border.all(color: swatchFg.withValues(alpha: 0.35)),
        ),
      ),
      title: Text(
        label,
        style: selected
            ? theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w700)
            : theme.textTheme.bodyLarge,
      ),
      trailing:
          selected ? Icon(Icons.check, color: scheme.primary) : null,
      onTap: () => Navigator.of(context).pop(status),
    );
  }
}
