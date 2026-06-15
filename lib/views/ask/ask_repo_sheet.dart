import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_strings.dart';
import '../../theme/app_dimens.dart';
import '../../theme/app_motion.dart';
import '../../view_models/ask_repo_vm.dart';
import 'ask_repo_chat.dart';

/// The global "Ask GitSync" chat — a draggable modal bottom sheet opened from
/// the repo-shell FAB on any tab. Renders the transcript (user bubbles + AI
/// markdown answers with commit + Discord source panels) and, while a question
/// is in flight, a live trace strip fed by the agent tool-trace stream.
///
/// Reads the [AskRepoViewModel] provided at the ShellRoute scope, so the FAB and
/// the sheet share one transcript across tabs.
class AskRepoSheet extends StatelessWidget {
  const AskRepoSheet({super.key});

  /// Opens the sheet as a draggable, full-height-capable modal. The caller must
  /// pass the ShellRoute's [AskRepoViewModel] so the sheet (a separate route
  /// subtree) can read it.
  static Future<void> show(BuildContext context, AskRepoViewModel vm) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      // Tune enter/exit to match the app's sheet timing (Flutter owns the
      // controller — no host widget needs to be promoted to stateful).
      sheetAnimationStyle: AppMotion.sheetStyle,
      builder: (_) => ChangeNotifierProvider.value(
        value: vm,
        child: const AskRepoSheet(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.85,
      minChildSize: 0.5,
      maxChildSize: 0.95,
      builder: (ctx, scrollController) => _AskRepoBody(
        scrollController: scrollController,
      ),
    );
  }
}

class _AskRepoBody extends StatefulWidget {
  const _AskRepoBody({required this.scrollController});
  final ScrollController scrollController;

  @override
  State<_AskRepoBody> createState() => _AskRepoBodyState();
}

class _AskRepoBodyState extends State<_AskRepoBody> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _send(AskRepoViewModel vm) {
    final text = _controller.text;
    if (text.trim().isEmpty || vm.sending) return;
    _controller.clear();
    vm.ask(text);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!widget.scrollController.hasClients) return;
      widget.scrollController.animateTo(
        widget.scrollController.position.maxScrollExtent,
        duration: AppMotion.medium,
        curve: AppMotion.emphasizedDecel,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    return Consumer<AskRepoViewModel>(
      builder: (ctx, vm, _) {
        return Column(
          children: [
            _SheetHeader(
              onNewSession: vm.sending ? null : vm.newSession,
            ),
            const Divider(height: 1),
            Expanded(
              child: ListView(
                controller: widget.scrollController,
                padding: const EdgeInsets.all(AppDimens.spacingMd),
                children: [
                  if (vm.turns.isEmpty) const AskRepoEmptyHint(),
                  for (final turn in vm.turns) AskRepoTurnView(turn: turn),
                  if (vm.sending) AskRepoLiveTraceStrip(steps: vm.liveSteps),
                ],
              ),
            ),
            AskRepoInputBar(
              controller: _controller,
              sending: vm.sending,
              onSend: () => _send(vm),
              bottomInset: MediaQuery.of(context).viewInsets.bottom,
            ),
          ],
        );
      },
    );
  }
}

class _SheetHeader extends StatelessWidget {
  const _SheetHeader({required this.onNewSession});
  final VoidCallback? onNewSession;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppDimens.spacingMd,
        AppDimens.spacingMd,
        AppDimens.spacingSm,
        AppDimens.spacingSm,
      ),
      child: Row(
        children: [
          Icon(Icons.auto_awesome, size: 22, color: scheme.primary),
          const SizedBox(width: AppDimens.spacingSm),
          Text(
            s.askRepoTitle,
            style: theme.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w700,
            ),
          ),
          const Spacer(),
          IconButton(
            tooltip: s.askRepoNewSession,
            onPressed: onNewSession,
            icon: const Icon(Icons.restart_alt),
          ),
          IconButton(
            tooltip: s.cancel,
            onPressed: () => Navigator.of(context).maybePop(),
            icon: const Icon(Icons.close),
          ),
        ],
      ),
    );
  }
}
