import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/commit.dart';
import '../../models/commit_graph.dart';
import '../../models/daily_report.dart';
import '../../models/discord_chat.dart';
import '../../models/discord_digest.dart';
import '../../l10n/app_strings.dart';
import '../../repositories/user_repo.dart';
import '../../theme/app_dimens.dart';
import '../../theme/app_motion.dart';
import '../../widgets/section_card.dart';
import '../../view_models/ask_repo_vm.dart';
import '../../view_models/commits_vm.dart';
import '../../view_models/daily_brief_vm.dart';
import '../../view_models/daily_report_vm.dart';
import '../../view_models/discord_chat_vm.dart';
import '../../view_models/discord_messages_vm.dart';
import '../../view_models/intel_range_vm.dart';
import '../../widgets/empty_state.dart';
import '../../widgets/markdown_view.dart';
import '../../widgets/staggered_entry.dart';
import '../ask/ask_repo_chat.dart';

// DailyViewPage — three tabs: Summary / Commits / Discord, all driven by ONE
// shared date range (IntelRangeViewModel). A single picker in the AppBar (shown
// from every tab) re-scopes all three tabs at once; clearing it returns each to
// its default. The page subscribes to the shared range and fans changes out to
// the per-tab ViewModels.
class DailyViewPage extends StatefulWidget {
  const DailyViewPage({super.key, required this.repoId});
  final String repoId;

  @override
  State<DailyViewPage> createState() => _DailyViewPageState();
}

class _DailyViewPageState extends State<DailyViewPage> {
  IntelRangeViewModel? _rangeVm;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final vm = context.read<IntelRangeViewModel>();
    if (!identical(vm, _rangeVm)) {
      _rangeVm?.removeListener(_onRangeChanged);
      _rangeVm = vm;
      _rangeVm!.addListener(_onRangeChanged);
    }
  }

  // Fans the shared range out to every tab's ViewModel. Setting a range scopes
  // Summary (per-day cards), the daily-brief chat, the Commits list+graph, the
  // Discord digest display + persisted backfill range, and the Discord chat's
  // read window. Clearing returns each tab to its default.
  void _onRangeChanged() {
    final range = _rangeVm?.range;
    final report = context.read<DailyReportViewModel>();
    final chat = context.read<DailyBriefChatViewModel>();
    final commits = context.read<CommitsViewModel>();
    final discord = context.read<DiscordMessagesViewModel>();
    final discordChat = context.read<DiscordChatViewModel>();
    if (range != null) {
      report.setRange(range.start, range.end);
      chat.setRange(range.start, range.end);
      commits.setRange(range.start, range.end);
      // D1+D3: setDiscordRange is now additive-only, so binding the shared range
      // to Discord is safe again — it persists the range (bot re-pulls + dedups)
      // and mirrors into the digest display. D2: the Discord chat reads the same
      // window.
      discord.setRange(range.start, range.end);
      discordChat.setRange(range.start, range.end);
    } else {
      final now = DateTime.now();
      report.clearRange();
      chat.setRange(now, now);
      commits.clearRange();
      // Clears only the Discord display scope (no callable — additive store
      // keeps everything). The chat is scoped to today (matching the displayed
      // "today" window) so it doesn't pull messages from unrelated past days.
      discord.clearViewRange();
      discordChat.setRange(now, now);
    }
  }

  @override
  void dispose() {
    _rangeVm?.removeListener(_onRangeChanged);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: Text(s.dailyTitle),
          actions: const [_SharedRefreshAction(), _SharedRangeAction()],
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(kTextTabBarHeight + 1),
            child: Column(
              children: [
                const Divider(height: 1),
                TabBar(
                  tabs: [
                    Tab(text: s.dailyTabSummary),
                    Tab(text: s.dailyTabCommits),
                    Tab(text: s.dailyTabDiscord),
                  ],
                ),
              ],
            ),
          ),
        ),
        body: const TabBarView(
          children: [_SummaryTab(), _CommitsTab(), _DiscordTab()],
        ),
      ),
    );
  }
}

// The one shared Refresh for all three tabs (D3), pinned in the AppBar next to
// the shared range picker. Refreshes everything for the current window:
//   - Commits: forces a branch-graph reload (the list view is realtime).
//   - Discord: re-requests a per-day backfill across the window (≤31 days; the
//     bot dedups), so missing days fill in.
//   - Summary: nothing (reports stream realtime; generation stays per-day).
// Disabled while either the graph or the Discord sweep is already in flight.
class _SharedRefreshAction extends StatelessWidget {
  const _SharedRefreshAction();

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    return Consumer2<CommitsViewModel, DiscordMessagesViewModel>(
      builder: (ctx, commits, discord, _) {
        final busy = commits.graphLoading || discord.refreshing;
        return IconButton(
          tooltip: s.refreshCurrentRange,
          icon: busy
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.refresh),
          onPressed: busy
              ? null
              : () {
                  commits.loadGraph(force: true);
                  discord.refreshWindow();
                },
        );
      },
    );
  }
}

// The one shared date-range picker for all three tabs, pinned in the AppBar so
// it's reachable from Summary / Commits / Discord alike. Picking sets the
// shared range; the reset icon (shown only while a range is active) clears it.
class _SharedRangeAction extends StatelessWidget {
  const _SharedRangeAction();

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    return Consumer<IntelRangeViewModel>(
      builder: (ctx, vm, _) {
        final range = vm.range;
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextButton.icon(
              style: TextButton.styleFrom(
                foregroundColor: Theme.of(ctx).colorScheme.onSurface,
              ),
              onPressed: () async {
                final now = DateTime.now();
                final picked = await showDateRangePicker(
                  context: ctx,
                  firstDate: DateTime(2020),
                  lastDate: now,
                  initialDateRange: range ?? DateTimeRange(start: now, end: now),
                );
                if (picked == null) return;
                vm.setRange(picked);
              },
              icon: const Icon(Icons.date_range_outlined, size: 18),
              label: Text(
                range == null
                    ? s.today
                    : '${_monthDay(range.start)} ~ ${_monthDay(range.end)}',
              ),
            ),
            if (range != null)
              IconButton(
                tooltip: s.resetRange,
                icon: const Icon(Icons.restore, size: 20),
                onPressed: vm.clear,
              ),
          ],
        );
      },
    );
  }
}

// The Summary tab is the developer "intelligence hub": an AI daily report
// (summary + highlights + blockers + commit-message rollup + per-member
// contributions) on top, and the global, repo-wide "Ask GitSync" assistant at
// the bottom. The report streams from `dailyReports/{date}`; the chat drives the
// SHARED [AskRepoViewModel] (the `askRepo` callable) — the same instance the
// repo-shell FAB opens, so the transcript is shared across both entry points.
// Both areas share one vertical scroll, with the chat input bar pinned to the
// bottom (mirrors the Discord tab).
class _SummaryTab extends StatefulWidget {
  const _SummaryTab();

  @override
  State<_SummaryTab> createState() => _SummaryTabState();
}

class _SummaryTabState extends State<_SummaryTab> {
  final _controller = TextEditingController();
  final _scrollController = ScrollController();

  // Whether the upper day-report panel (D2) is expanded. Starts collapsed for
  // multi-day ranges so the chat gets more room; single-day starts expanded.
  bool? _reportsExpanded;

  @override
  void dispose() {
    _controller.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _send(AskRepoViewModel vm) {
    final text = _controller.text;
    if (text.trim().isEmpty || vm.sending) return;
    _controller.clear();
    vm.ask(text);
    // Jump to the latest turn once it's laid out.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: AppMotion.medium,
        curve: AppMotion.emphasizedDecel,
      );
    });
  }

  // Builds one collapsible report card per day in the selected range. With no
  // range (single day) it's just today's card; with a range it's one card per
  // day, today expanded by default and the rest collapsed.
  List<Widget> _dayCards(DailyReportViewModel report) {
    final todayKey = DailyReportViewModel.dayKeyOf(DateTime.now());
    final days = report.rangeDays;
    return [
      for (var i = 0; i < days.length; i++) ...[
        // Stagger keyed by day-key so a range change doesn't replay the
        // entrance tween on still-mounted cards.
        StaggeredEntry(
          key: ValueKey('day-${DailyReportViewModel.dayKeyOf(days[i])}'),
          index: i,
          child: _DayReportCard(
            key: ValueKey(DailyReportViewModel.dayKeyOf(days[i])),
            vm: report,
            day: days[i],
            initiallyExpanded:
                DailyReportViewModel.dayKeyOf(days[i]) == todayKey,
          ),
        ),
        const SizedBox(height: AppDimens.spacingSm),
      ],
    ];
  }

  @override
  Widget build(BuildContext context) {
    return Consumer2<DailyReportViewModel, AskRepoViewModel>(
      builder: (ctx, report, chat, _) {
        if (report.loading) {
          return const Center(child: CircularProgressIndicator());
        }
        // Default: expanded for single-day, collapsed for multi-day ranges so
        // the chat area gets more room.
        final expanded = _reportsExpanded ?? report.isSingleDay;
        // Cap the day-report panel at ~42% of the viewport so many days never
        // push the chat off screen — it scrolls internally instead (D2).
        final panelMaxHeight = MediaQuery.of(ctx).size.height * 0.42;
        // Count how many days are currently generating (for progress label).
        final generatingCount = report.rangeDays
            .where((d) => report.isGeneratingDay(
                DailyReportViewModel.dayKeyOf(d)))
            .length;
        return Column(
          children: [
            // ---- Upper panel: collapsible, fixed-height, internally scrollable
            _ReportsPanel(
              dayCount: report.rangeDays.length,
              expanded: expanded,
              maxHeight: panelMaxHeight,
              generatingCount: generatingCount,
              onToggle: () =>
                  setState(() => _reportsExpanded = !expanded),
              cards: _dayCards(report),
            ),
            const Divider(height: 1),
            // ---- Lower area: the global "Ask GitSync" chat, own scroll. Drives
            // the shared AskRepoViewModel (same instance as the FAB sheet), so
            // its transcript is repo-wide and shared across both entry points.
            Expanded(
              child: ListView(
                controller: _scrollController,
                padding: const EdgeInsets.all(AppDimens.spacingMd),
                children: [
                  const _AskRepoHeader(),
                  const SizedBox(height: AppDimens.spacingSm),
                  if (chat.turns.isEmpty)
                    const AskRepoEmptyHint()
                  else
                    for (final turn in chat.turns) AskRepoTurnView(turn: turn),
                  if (chat.sending) AskRepoLiveTraceStrip(steps: chat.liveSteps),
                ],
              ),
            ),
            AskRepoInputBar(
              controller: _controller,
              sending: chat.sending,
              onSend: () => _send(chat),
              onNewSession: chat.sending ? null : chat.newSession,
            ),
          ],
        );
      },
    );
  }
}

// D2: the upper day-report panel. A tappable header row ("日報" + day count +
// chevron) collapses/expands the whole panel; when expanded the day cards live
// in a fixed-height, internally scrollable region (so many days don't push the
// chat off screen). The day cards keep their own per-card collapse.
class _ReportsPanel extends StatefulWidget {
  const _ReportsPanel({
    required this.dayCount,
    required this.expanded,
    required this.maxHeight,
    required this.onToggle,
    required this.cards,
    this.generatingCount = 0,
  });

  final int dayCount;
  final bool expanded;
  final double maxHeight;
  final VoidCallback onToggle;
  final List<Widget> cards;
  final int generatingCount;

  @override
  State<_ReportsPanel> createState() => _ReportsPanelState();
}

class _ReportsPanelState extends State<_ReportsPanel> {
  final ScrollController _scrollController = ScrollController();

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          expanded: widget.expanded,
          button: true,
          label: s.dailyReport,
          child: InkWell(
            onTap: widget.onToggle,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(
                AppDimens.spacingMd,
                AppDimens.spacingSm,
                AppDimens.spacingSm,
                AppDimens.spacingSm,
              ),
              child: Row(
                children: [
                  Icon(Icons.summarize_outlined, size: 20, color: scheme.primary),
                  const SizedBox(width: AppDimens.spacingSm),
                  Text(
                    s.dailyReport,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(width: AppDimens.spacingSm),
                  _CountChip(
                    icon: Icons.calendar_today_outlined,
                    label: '${widget.dayCount}',
                  ),
                  if (widget.generatingCount > 0) ...[
                    const SizedBox(width: AppDimens.spacingSm),
                    Text(
                      s.generatingDayProgress(
                        widget.dayCount - widget.generatingCount,
                        widget.dayCount,
                      ),
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: scheme.primary,
                      ),
                    ),
                  ],
                  const Spacer(),
                  AnimatedRotation(
                    turns: widget.expanded ? 0.5 : 0,
                    duration: AppMotion.short,
                    child: const Icon(Icons.expand_more),
                  ),
                ],
              ),
            ),
          ),
        ),
        if (widget.expanded)
          ConstrainedBox(
            constraints: BoxConstraints(maxHeight: widget.maxHeight),
            // Scrollbar pinned flush to the panel's far-right edge: the ListView
            // carries no right padding, so the scrollbar gutter sits at the
            // outermost right. Each child gets its own right inset instead.
            child: Scrollbar(
              controller: _scrollController,
              thumbVisibility: true,
              child: ListView(
                controller: _scrollController,
                padding: const EdgeInsets.fromLTRB(
                  AppDimens.spacingMd,
                  0,
                  0,
                  AppDimens.spacingMd,
                ),
                shrinkWrap: true,
                children: [
                  for (final card in widget.cards)
                    Padding(
                      padding: const EdgeInsets.only(
                        right: AppDimens.spacingSm,
                      ),
                      child: card,
                    ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

// One collapsible per-day report card (mirrors _DigestCard's interaction:
// tappable header + animated chevron + conditional body). Collapsed shows the
// date and a one-line summary; expanded shows the full report (summary +
// highlights + commit rollup + contributions) with a regenerate action, or a
// "產生日報" generate button when the day has no report yet.
class _DayReportCard extends StatefulWidget {
  const _DayReportCard({
    super.key,
    required this.vm,
    required this.day,
    required this.initiallyExpanded,
  });
  final DailyReportViewModel vm;
  final DateTime day;
  final bool initiallyExpanded;

  @override
  State<_DayReportCard> createState() => _DayReportCardState();
}

class _DayReportCardState extends State<_DayReportCard> {
  late bool _expanded = widget.initiallyExpanded;

  String get _dayKeyStr => DailyReportViewModel.dayKeyOf(widget.day);

  String _headerLabel(String today) {
    final todayKey = DailyReportViewModel.dayKeyOf(DateTime.now());
    return _dayKeyStr == todayKey ? '$today · $_dayKeyStr' : _dayKeyStr;
  }

  String _summaryLine(DailyReport? report, String noReportYet) {
    if (report == null || report.isEmpty) return noReportYet;
    final first = report.summary.split('\n').first.trim();
    return first.isEmpty ? noReportYet : first;
  }

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final vm = widget.vm;
    final report = vm.reportForDay(_dayKeyStr);
    final hasReport = report != null && !report.isEmpty;
    final generating = vm.isGeneratingDay(_dayKeyStr);

    return AnimatedContainer(
      duration: AppMotion.medium,
      curve: AppMotion.emphasizedDecel,
      decoration: BoxDecoration(
        color: theme.brightness == Brightness.light
            ? const Color(0xFFFFFFFF)
            : scheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(AppDimens.radiusMd),
        border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.4)),
        boxShadow: [
          BoxShadow(
            color: scheme.shadow.withValues(alpha: 0.06),
            blurRadius: 6,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // ---- Header (tap to collapse/expand) ----
          Semantics(
            expanded: _expanded,
            button: true,
            child: InkWell(
              onTap: () => setState(() => _expanded = !_expanded),
              borderRadius: BorderRadius.circular(AppDimens.radiusMd),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppDimens.spacingMd,
                  AppDimens.spacingSm,
                  AppDimens.spacingSm,
                  AppDimens.spacingSm,
                ),
                child: Row(
                  children: [
                    Icon(
                      Icons.auto_awesome_outlined,
                      size: 20,
                      color: scheme.primary,
                    ),
                    const SizedBox(width: AppDimens.spacingSm),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            _headerLabel(s.today),
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          if (!_expanded)
                            Text(
                              _summaryLine(report, s.noReportYet),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: scheme.onSurfaceVariant,
                              ),
                            ),
                        ],
                      ),
                    ),
                    if (report != null && report.commitCount > 0) ...[
                      const SizedBox(width: AppDimens.spacingSm),
                      _CountChip(
                        icon: Icons.commit_outlined,
                        label: '${report.commitCount}',
                      ),
                    ],
                    AnimatedRotation(
                      turns: _expanded ? 0.5 : 0,
                      duration: AppMotion.short,
                      child: const Icon(Icons.expand_more),
                    ),
                  ],
                ),
              ),
            ),
          ),
          // ---- Collapsible body ----
          AnimatedSize(
            duration: AppMotion.short,
            curve: AppMotion.emphasizedDecel,
            alignment: Alignment.topCenter,
            child: _expanded
                ? Padding(
                    padding: const EdgeInsets.fromLTRB(
                      AppDimens.spacingMd,
                      0,
                      AppDimens.spacingMd,
                      AppDimens.spacingMd,
                    ),
                    child: hasReport
                        ? _DayReportBody(vm: vm, day: widget.day, report: report)
                        : _DayReportEmpty(
                            generating: generating,
                            onGenerate: () => vm.generateDay(
                              widget.day,
                              language: context.l10n.backendLanguage,
                            ),
                          ),
                  )
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }
}

// The expanded body of a day card that HAS a report: summary text, a
// regenerate action, then the existing highlights / rollup / contributions
// content widgets (reused, not duplicated).
class _DayReportBody extends StatelessWidget {
  const _DayReportBody({
    required this.vm,
    required this.day,
    required this.report,
  });
  final DailyReportViewModel vm;
  final DateTime day;
  final DailyReport report;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final generating = vm.isGeneratingDay(DailyReportViewModel.dayKeyOf(day));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(report.summary, style: theme.textTheme.bodyMedium),
        const SizedBox(height: AppDimens.spacingSm),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: generating
                ? null
                : () => vm.generateDay(
                      day,
                      language: context.l10n.backendLanguage,
                    ),
            icon: generating
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh, size: 18),
            label: Text(generating ? s.generating : s.regenerateReport),
          ),
        ),
        _HighlightsCard(report: report),
        _CommitRollupCard(report: report),
        _ContributionsCard(report: report),
      ],
    );
  }
}

// The expanded body of a day card with NO report yet: a "產生日報" button.
class _DayReportEmpty extends StatelessWidget {
  const _DayReportEmpty({required this.generating, required this.onGenerate});
  final bool generating;
  final VoidCallback onGenerate;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          s.dayNoReportHint,
          style: theme.textTheme.bodyMedium,
        ),
        const SizedBox(height: AppDimens.spacingMd),
        Align(
          alignment: Alignment.centerLeft,
          child: FilledButton.icon(
            onPressed: generating ? null : onGenerate,
            icon: generating
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.auto_awesome_outlined),
            label: Text(generating ? s.generating : s.generateReport),
          ),
        ),
      ],
    );
  }
}

// Highlights (wins) + blockers, each a labelled list. Renders nothing for an
// empty section so the card stays compact.
class _HighlightsCard extends StatelessWidget {
  const _HighlightsCard({required this.report});
  final DailyReport report;

  @override
  Widget build(BuildContext context) {
    if (report.highlights.isEmpty && report.blockers.isEmpty) {
      return const SizedBox.shrink();
    }
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: AppDimens.spacingMd),
      child: SectionCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.emoji_events_outlined,
                  size: 20,
                  color: scheme.primary,
                ),
                const SizedBox(width: AppDimens.spacingSm),
                Text(
                  s.highlights,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppDimens.spacingSm),
            for (final h in report.highlights)
              _BulletRow(
                icon: Icons.check_circle_outline,
                color: scheme.primary,
                text: h,
              ),
            if (report.highlights.isNotEmpty && report.blockers.isNotEmpty)
              const SizedBox(height: AppDimens.spacingSm),
            for (final b in report.blockers)
              _BulletRow(
                icon: Icons.report_problem_outlined,
                color: scheme.error,
                text: b,
              ),
          ],
        ),
      ),
    );
  }
}

// Commit-message rollup: the day's commits grouped into AI-labelled themes.
class _CommitRollupCard extends StatelessWidget {
  const _CommitRollupCard({required this.report});
  final DailyReport report;

  @override
  Widget build(BuildContext context) {
    if (report.commitThemes.isEmpty) return const SizedBox.shrink();
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: AppDimens.spacingMd),
      child: SectionCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.merge_type_outlined,
                  size: 20,
                  color: scheme.tertiary,
                ),
                const SizedBox(width: AppDimens.spacingSm),
                Text(
                  s.commitRollup,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppDimens.spacingSm),
            for (final t in report.commitThemes)
              Padding(
                padding: const EdgeInsets.only(bottom: AppDimens.spacingSm),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            t.theme,
                            style: theme.textTheme.bodyMedium?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          if (t.summary.isNotEmpty)
                            Text(
                              t.summary,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: scheme.onSurfaceVariant,
                              ),
                            ),
                        ],
                      ),
                    ),
                    if (t.commitCount > 0) ...[
                      const SizedBox(width: AppDimens.spacingSm),
                      _CountChip(
                        icon: Icons.commit_outlined,
                        label: '${t.commitCount}',
                      ),
                    ],
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

// Per-member contribution chips (tasks done + commits), keyed as the backend
// reports them (userId, or author login for unmatched commits).
class _ContributionsCard extends StatefulWidget {
  const _ContributionsCard({required this.report});
  final DailyReport report;

  @override
  State<_ContributionsCard> createState() => _ContributionsCardState();
}

class _ContributionsCardState extends State<_ContributionsCard> {
  final UserRepository _users = UserRepository();
  // UID -> display name, filled in for members the report named only by UID.
  Map<String, String> _resolved = {};

  @override
  void initState() {
    super.initState();
    _resolveNames();
  }

  @override
  void didUpdateWidget(covariant _ContributionsCard old) {
    super.didUpdateWidget(old);
    if (old.report != widget.report) _resolveNames();
  }

  // The report usually stores only the Firebase UID for roster members, so look
  // the unnamed ones up in their user doc (UID -> githubLogin / name). Without
  // this the chip shows a raw 28-char UID instead of the GitHub handle.
  Future<void> _resolveNames() async {
    final entries = widget.report.memberContributions.entries
        .where((e) => e.value.tasksDone > 0 || e.value.commits > 0);
    final out = <String, String>{};
    for (final e in entries) {
      if (_reportLabel(e) != null) continue; // already named by the report
      try {
        final u = await _users.getUser(e.key);
        if (u == null) continue;
        final name = u.githubLogin.isNotEmpty
            ? u.githubLogin
            : (u.name.isNotEmpty ? u.name : null);
        if (name != null) out[e.key] = name;
      } catch (_) {
        // leave unresolved -> UID fallback
      }
    }
    if (mounted && out.isNotEmpty) setState(() => _resolved = out);
  }

  // Name the report itself carries (githubLogin -> displayName), or null.
  static String? _reportLabel(MapEntry<String, MemberContribution> e) {
    final login = e.value.githubLogin;
    if (login != null && login.isNotEmpty) return login;
    final name = e.value.displayName;
    if (name != null && name.isNotEmpty) return name;
    return null;
  }

  // Final label: report name -> resolved user-doc name -> raw key (UID).
  String _memberLabel(MapEntry<String, MemberContribution> e) =>
      _reportLabel(e) ?? _resolved[e.key] ?? e.key;

  static String _initial(String key) =>
      key.isEmpty ? '?' : key.substring(0, 1).toUpperCase();

  @override
  Widget build(BuildContext context) {
    final report = widget.report;
    final entries = report.memberContributions.entries
        .where((e) => e.value.tasksDone > 0 || e.value.commits > 0)
        .toList();
    if (entries.isEmpty) return const SizedBox.shrink();
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: AppDimens.spacingMd),
      child: SectionCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.groups_outlined,
                  size: 20,
                  color: scheme.secondary,
                ),
                const SizedBox(width: AppDimens.spacingSm),
                Text(
                  s.contributions,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppDimens.spacingSm),
              Wrap(
                spacing: AppDimens.spacingSm,
                runSpacing: AppDimens.spacingSm,
                children: [
                  for (final e in entries)
                    Semantics(
                      label: '${_memberLabel(e)}: '
                          '${e.value.tasksDone} tasks, '
                          '${e.value.commits} commits',
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: AppDimens.spacingSm,
                          vertical: AppDimens.spacingXs,
                        ),
                        decoration: BoxDecoration(
                          color: scheme.surfaceContainerHighest,
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            CircleAvatar(
                              radius: 10,
                              backgroundColor: scheme.primaryContainer,
                              child: Text(
                                _initial(_memberLabel(e)),
                                style: theme.textTheme.labelSmall?.copyWith(
                                  color: scheme.onPrimaryContainer,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                            const SizedBox(width: AppDimens.spacingXs),
                            ConstrainedBox(
                              constraints: const BoxConstraints(maxWidth: 120),
                              child: Text(
                                _memberLabel(e),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.labelMedium,
                              ),
                            ),
                            const SizedBox(width: AppDimens.spacingXs),
                            Text(
                              '·  ${e.value.tasksDone}✓ ${e.value.commits}⎇',
                              style: theme.textTheme.labelMedium,
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            ],
          ),
        ),
      );
  }
}

class _BulletRow extends StatelessWidget {
  const _BulletRow({
    required this.icon,
    required this.color,
    required this.text,
  });
  final IconData icon;
  final Color color;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(width: AppDimens.spacingSm),
          Expanded(
            child: Text(text, style: Theme.of(context).textTheme.bodyMedium),
          ),
        ],
      ),
    );
  }
}

class _CountChip extends StatelessWidget {
  const _CountChip({required this.icon, required this.label});
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: scheme.onSurfaceVariant),
          const SizedBox(width: 4),
          Text(label, style: Theme.of(context).textTheme.labelSmall),
        ],
      ),
    );
  }
}

// The global "Ask GitSync" section header for the Summary tab's chat. Repo-wide
// framing (not date-scoped) — reuses the shared `askRepoTitle` string.
class _AskRepoHeader extends StatelessWidget {
  const _AskRepoHeader();

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(Icons.auto_awesome, size: 20, color: scheme.primary),
            const SizedBox(width: AppDimens.spacingSm),
            Text(
              s.askRepoTitle,
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(left: 28),
          child: Text(
            s.askRepoScope,
            style: theme.textTheme.bodySmall?.copyWith(
              color: scheme.onSurfaceVariant,
            ),
          ),
        ),
      ],
    );
  }
}

// Commits tab — a scrollable commit visualization. The default branch graph
// shows real topology; the list view is a flat, filterable commit list. Tap a
// commit → an AI explanation of the work (the `explainCommit` callable, cached
// per sha). A range button filters to an inclusive day range.
class _CommitsTab extends StatelessWidget {
  const _CommitsTab();

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    return Consumer<CommitsViewModel>(
      builder: (ctx, vm, _) {
        if (vm.loading) {
          return const Center(child: CircularProgressIndicator());
        }
        if (vm.streamError != null) {
          return Center(
            child: Padding(
              padding: const EdgeInsets.all(AppDimens.spacingLg),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.error_outline, size: 40),
                  const SizedBox(height: AppDimens.spacingSm),
                  Text(
                    s.couldNotLoadCommits,
                    style: Theme.of(ctx).textTheme.titleMedium,
                  ),
                  const SizedBox(height: AppDimens.spacingXs),
                  Text(
                    vm.streamError!,
                    style: Theme.of(ctx).textTheme.bodySmall,
                    textAlign: TextAlign.center,
                    maxLines: 4,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: AppDimens.spacingMd),
                  FilledButton.icon(
                    onPressed: vm.retry,
                    icon: const Icon(Icons.refresh, size: 18),
                    label: Text(s.retry),
                  ),
                ],
              ),
            ),
          );
        }
        return Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppDimens.spacingMd,
                AppDimens.spacingMd,
                AppDimens.spacingMd,
                0,
              ),
              child: Row(
                children: [
                  Text(
                    s.commitMap,
                    style: Theme.of(ctx).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Spacer(),
                  // Refresh is now the single shared AppBar action (D3); the
                  // branch graph reloads from there.
                  // Branch topology vs the flat, filterable commit list (D4).
                  SegmentedButton<CommitsViewMode>(
                    segments: [
                      ButtonSegment(
                        value: CommitsViewMode.branch,
                        icon: const Icon(Icons.account_tree_outlined, size: 18),
                        tooltip: s.branchGraph,
                      ),
                      ButtonSegment(
                        value: CommitsViewMode.author,
                        icon: const Icon(Icons.view_list_outlined, size: 18),
                        tooltip: s.listView,
                      ),
                    ],
                    selected: {vm.viewMode},
                    onSelectionChanged: (s) => vm.setViewMode(s.first),
                    showSelectedIcon: false,
                    style: const ButtonStyle(
                      visualDensity: VisualDensity.compact,
                    ),
                  ),
                ],
              ),
            ),
            // Scope row: the date range is picked once in the AppBar (shared
            // across all tabs). This shows the current scope and offers the
            // "Recent 50" reset, which clears the shared range.
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppDimens.spacingMd,
                AppDimens.spacingXs,
                AppDimens.spacingMd,
                AppDimens.spacingSm,
              ),
              child: Row(
                children: [
                  Icon(
                    vm.hasRange
                        ? Icons.date_range_outlined
                        : Icons.history_outlined,
                    size: 16,
                    color: Theme.of(ctx).colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: AppDimens.spacingXs),
                  Text(
                    vm.hasRange
                        ? '${_monthDay(vm.rangeStart!)} ~ ${_monthDay(vm.rangeEnd!)}'
                        : s.recent50,
                    style: Theme.of(ctx).textTheme.bodySmall?.copyWith(
                          color: Theme.of(ctx).colorScheme.onSurfaceVariant,
                        ),
                  ),
                  if (vm.hasRange) ...[
                    const SizedBox(width: AppDimens.spacingSm),
                    ActionChip(
                      avatar: const Icon(Icons.restore, size: 16),
                      label: Text(s.recent50),
                      onPressed: () =>
                          ctx.read<IntelRangeViewModel>().clear(),
                      visualDensity: VisualDensity.compact,
                    ),
                  ],
                ],
              ),
            ),
            Expanded(
              child: vm.viewMode == CommitsViewMode.branch
                  ? _BranchGraphView(vm: vm)
                  : _CommitListView(vm: vm),
            ),
          ],
        );
      },
    );
  }
}

// Lane palette for the graph/list (also the per-branch color source via
// branchColorIndex). Wraps around if there are more branches than colors.
const List<Color> _laneColors = [
  Color(0xFF4C9AFF), // blue
  Color(0xFF36B37E), // green
  Color(0xFFFF8B00), // orange
  Color(0xFF9C5FFF), // purple
  Color(0xFFFF5B7A), // pink
  Color(0xFF00B8D9), // teal
];

// One row of the flattened list: a day header or a commit.
class _ListItem {
  _ListItem.header(this.dayLabel) : commit = null;
  _ListItem.commit(Commit this.commit) : dayLabel = null;

  final String? dayLabel;
  final Commit? commit;

  bool get isHeader => dayLabel != null;
}

// The flat, filterable commit list (D4): a filter chip bar (author / branch /
// keyword) on top, then the commits grouped under day headers — no per-author
// lane rail. Filters compose (AND across dimensions, OR within a multi-select).
class _CommitListView extends StatefulWidget {
  const _CommitListView({required this.vm});
  final CommitsViewModel vm;

  @override
  State<_CommitListView> createState() => _CommitListViewState();
}

class _CommitListViewState extends State<_CommitListView> {
  final _keywordController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _keywordController.text = widget.vm.keyword;
  }

  @override
  void dispose() {
    _keywordController.dispose();
    super.dispose();
  }

  List<_ListItem> _items(List<Commit> commits) {
    final items = <_ListItem>[];
    String? lastDay;
    for (final c in commits) {
      final day = _dayKey(c.committedAt.toDate());
      if (day != lastDay) {
        items.add(_ListItem.header(day));
        lastDay = day;
      }
      items.add(_ListItem.commit(c));
    }
    return items;
  }

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final vm = widget.vm;
    final filtered = vm.filteredCommits;
    return Column(
      children: [
        _CommitFilterBar(vm: vm, keywordController: _keywordController),
        Expanded(
          child: vm.commits.isEmpty
              ? EmptyState(
                  icon: Icons.commit_outlined,
                  title: s.noCommits,
                  message: s.noCommitsInPeriod,
                  action: vm.hasRange
                      ? ActionChip(
                          avatar: const Icon(Icons.restore, size: 16),
                          label: Text(s.recent50),
                          onPressed: () =>
                              context.read<IntelRangeViewModel>().clear(),
                        )
                      : null,
                )
              : filtered.isEmpty
                  ? EmptyState(
                      icon: Icons.filter_list_off_outlined,
                      title: s.noMatchingCommits,
                      message: s.noCommitsMatchFilters,
                      action: ActionChip(
                        avatar: const Icon(Icons.clear, size: 16),
                        label: Text(s.clearFilters),
                        onPressed: vm.clearFilters,
                      ),
                    )
                  : Builder(
                      builder: (ctx) {
                        final items = _items(filtered);
                        return ListView.builder(
                          padding: const EdgeInsets.only(
                            bottom: AppDimens.spacingMd,
                          ),
                          itemCount: items.length,
                          itemBuilder: (ctx, i) {
                            final item = items[i];
                            if (item.isHeader) {
                              return _DayHeader(label: item.dayLabel!);
                            }
                            return _CommitListRow(commit: item.commit!, vm: vm);
                          },
                        );
                      },
                    ),
        ),
      ],
    );
  }
}

// Filter chip bar for the commit list: Author + Branch multi-selects, a compact
// keyword field, and a clear-all chip. Horizontally scrollable so it never
// overflows on a narrow window.
class _CommitFilterBar extends StatelessWidget {
  const _CommitFilterBar({required this.vm, required this.keywordController});
  final CommitsViewModel vm;
  final TextEditingController keywordController;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppDimens.spacingMd,
        0,
        AppDimens.spacingMd,
        AppDimens.spacingSm,
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            FilterChip(
              avatar: const Icon(Icons.person_outline, size: 16),
              label: Text(
                vm.authorFilter.isEmpty
                    ? s.author
                    : s.authorCount(vm.authorFilter.length),
              ),
              selected: vm.authorFilter.isNotEmpty,
              onSelected: (_) => _pickMulti(
                context,
                title: s.author,
                options: vm.availableAuthors,
                selected: vm.authorFilter,
                onToggle: vm.toggleAuthorFilter,
              ),
            ),
            const SizedBox(width: AppDimens.spacingSm),
            FilterChip(
              avatar: const Icon(Icons.account_tree_outlined, size: 16),
              label: Text(
                vm.branchFilter.isEmpty
                    ? s.branch
                    : s.branchCount(vm.branchFilter.length),
              ),
              selected: vm.branchFilter.isNotEmpty,
              onSelected: (_) => _pickMulti(
                context,
                title: s.branch,
                options: vm.availableBranches,
                selected: vm.branchFilter,
                onToggle: vm.toggleBranchFilter,
              ),
            ),
            const SizedBox(width: AppDimens.spacingSm),
            SizedBox(
              width: 180,
              child: TextField(
                controller: keywordController,
                onChanged: vm.setKeyword,
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  hintText: s.searchMessageHint,
                  prefixIcon: const Icon(Icons.search, size: 18),
                  suffixIcon: vm.keyword.isEmpty
                      ? null
                      : IconButton(
                          icon: const Icon(Icons.clear, size: 16),
                          onPressed: () {
                            keywordController.clear();
                            vm.setKeyword('');
                          },
                        ),
                  isDense: true,
                  border: const OutlineInputBorder(),
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: AppDimens.spacingSm,
                    vertical: AppDimens.spacingSm,
                  ),
                ),
              ),
            ),
            if (vm.hasFilters) ...[
              const SizedBox(width: AppDimens.spacingSm),
              ActionChip(
                avatar: Icon(Icons.clear, size: 16, color: scheme.error),
                label: Text(s.clear),
                onPressed: () {
                  keywordController.clear();
                  vm.clearFilters();
                },
              ),
            ],
          ],
        ),
      ),
    );
  }

  // Multi-select popup: tap toggles a value; the list reflects live selection.
  Future<void> _pickMulti(
    BuildContext context, {
    required String title,
    required List<String> options,
    required Set<String> selected,
    required void Function(String) onToggle,
  }) {
    final s = context.l10n;
    return showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) {
        final theme = Theme.of(ctx);
        return SafeArea(
          child: StatefulBuilder(
            builder: (ctx, setSheetState) => Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppDimens.spacingMd,
                    0,
                    AppDimens.spacingMd,
                    AppDimens.spacingSm,
                  ),
                  child: Text(
                    title,
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                if (options.isEmpty)
                  Padding(
                    padding: const EdgeInsets.all(AppDimens.spacingMd),
                    child: Text(s.nothingToFilterBy),
                  )
                else
                  Flexible(
                    child: ListView(
                      shrinkWrap: true,
                      children: [
                        for (final opt in options)
                          CheckboxListTile(
                            dense: true,
                            value: selected.contains(opt),
                            title: Text(opt),
                            onChanged: (_) {
                              onToggle(opt);
                              setSheetState(() {});
                            },
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}

// One commit row in the flat list (no lane rail): message + author/branch/sha.
class _CommitListRow extends StatelessWidget {
  const _CommitListRow({required this.commit, required this.vm});
  final Commit commit;
  final CommitsViewModel vm;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final c = commit;
    final branch = CommitsViewModel.branchLabel(c);
    return InkWell(
      onTap: () => _showCommitSheet(context, c, vm),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppDimens.spacingMd,
          vertical: AppDimens.spacingSm,
        ),
        child: Row(
          children: [
            Container(
              width: 8,
              height: 8,
              margin: const EdgeInsets.only(top: 2, right: AppDimens.spacingSm),
              decoration: BoxDecoration(
                color: _BranchGraphRow.branchColor(branch),
                shape: BoxShape.circle,
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    c.message.split('\n').first,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          '${c.author.name.isEmpty ? c.author.login : c.author.name}'
                          ' · $branch'
                          ' · ${c.sha.length >= 7 ? c.sha.substring(0, 7) : c.sha}'
                          ' · ${_hhmm(c.committedAt.toDate())}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: scheme.onSurfaceVariant,
                          ),
                        ),
                      ),
                      if (c.aiSummary != null) ...[
                        const SizedBox(width: AppDimens.spacingXs),
                        Icon(
                          Icons.auto_awesome_outlined,
                          size: 12,
                          color: scheme.primary,
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right, size: 18, color: scheme.outline),
          ],
        ),
      ),
    );
  }
}

// Day separator row shared by both commit visualizations.
class _DayHeader extends StatelessWidget {
  const _DayHeader({required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppDimens.spacingMd,
        AppDimens.spacingSm,
        AppDimens.spacingMd,
        AppDimens.spacingXs,
      ),
      child: Row(
        children: [
          Text(
            label,
            style: Theme.of(context).textTheme.labelMedium?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(width: AppDimens.spacingSm),
          const Expanded(child: Divider(height: 1)),
        ],
      ),
    );
  }
}

// ---- Branch graph view (real topology via getCommitGraph) -------------------

// Hard cap on graph columns — deeper lanes share the last column so the rail
// never paints over the text (pathological histories can get wide).
const int _maxGraphLanes = 6;

// Either a day header or a commit row with its lane geometry.
class _GraphListItem {
  _GraphListItem.header(this.dayLabel) : row = null;
  _GraphListItem.row(GraphRowGeometry this.row) : dayLabel = null;

  final String? dayLabel;
  final GraphRowGeometry? row;

  bool get isHeader => dayLabel != null;
}

// The branch-topology visualization: lanes are branch lines (not authors),
// with fork and merge edges from real parent SHAs (getCommitGraph callable).
class _BranchGraphView extends StatelessWidget {
  const _BranchGraphView({required this.vm});
  final CommitsViewModel vm;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    if (vm.graphLoading && vm.graph == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (vm.graphError != null && vm.graph == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(AppDimens.spacingLg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, size: 40),
              const SizedBox(height: AppDimens.spacingSm),
              Text(
                s.couldNotLoadBranchGraph,
                style: theme.textTheme.titleMedium,
              ),
              const SizedBox(height: AppDimens.spacingXs),
              Text(
                vm.graphError!,
                style: theme.textTheme.bodySmall,
                textAlign: TextAlign.center,
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: AppDimens.spacingMd),
              FilledButton.icon(
                onPressed: vm.loadGraph,
                icon: const Icon(Icons.refresh, size: 18),
                label: Text(s.retry),
              ),
            ],
          ),
        ),
      );
    }
    final graph = vm.graph;
    if (graph == null || graph.commits.isEmpty) {
      return EmptyState(
        icon: Icons.account_tree_outlined,
        title: s.noCommits,
        message: s.noCommitsInPeriod,
        action: vm.hasRange
            ? ActionChip(
                avatar: const Icon(Icons.restore, size: 16),
                label: Text(s.recent50),
                onPressed: () => context.read<IntelRangeViewModel>().clear(),
              )
            : null,
      );
    }

    final rows = buildGraphRows(graph.commits);
    final tips = graph.tipLabels;
    var railLanes = 1;
    for (final r in rows) {
      railLanes = math.max(railLanes, r.laneSpan);
    }
    railLanes = railLanes.clamp(1, _maxGraphLanes);

    // Interleave day headers (same grouping as the list view).
    final items = <_GraphListItem>[];
    String? lastDay;
    for (final r in rows) {
      final day = _dayKey(r.commit.committedAt);
      if (day != lastDay) {
        items.add(_GraphListItem.header(day));
        lastDay = day;
      }
      items.add(_GraphListItem.row(r));
    }

    return Column(
      children: [
        if (graph.truncated)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppDimens.spacingMd,
              0,
              AppDimens.spacingMd,
              AppDimens.spacingXs,
            ),
            child: Row(
              children: [
                Icon(
                  Icons.info_outline,
                  size: 14,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: AppDimens.spacingXs),
                Expanded(
                  child: Text(
                    s.largeHistoryNotice,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
            ),
          ),
        Expanded(
          // Pull-to-refresh forces a fresh fetch; AlwaysScrollableScrollPhysics
          // lets the gesture work even when the list fits on screen.
          child: RefreshIndicator(
            onRefresh: () => vm.loadGraph(force: true),
            child: ListView.builder(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.only(bottom: AppDimens.spacingMd),
              itemCount: items.length,
              itemBuilder: (ctx, i) {
                final item = items[i];
                if (item.isHeader) return _DayHeader(label: item.dayLabel!);
                return _BranchGraphRow(
                  row: item.row!,
                  railLanes: railLanes,
                  branchTip: tips[item.row!.commit.sha],
                  vm: vm,
                );
              },
            ),
          ),
        ),
      ],
    );
  }
}

class _BranchGraphRow extends StatelessWidget {
  const _BranchGraphRow({
    required this.row,
    required this.railLanes,
    required this.vm,
    this.branchTip,
  });

  final GraphRowGeometry row;
  final int railLanes;
  final CommitsViewModel vm;

  /// Branch name when this commit is a branch tip (labeled chip).
  final String? branchTip;

  /// Branch color for a branch name (stable across reloads). Used by the node
  /// dot, the tip chip, the rail-tap legend and the list-row dot.
  static Color branchColor(String branch) =>
      _laneColors[branchColorIndex(branch, _laneColors.length)];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final g = row.commit;
    final laneWidth = 16.0;
    // Color by BRANCH (stable across reloads), not by lane index.
    final color = branchColor(g.primaryBranch);
    final railWidth = railLanes * laneWidth + AppDimens.spacingSm;

    return InkWell(
      onTap: () {
        // Prefer the full Firestore commit (files/diff stats for the sheet);
        // commits outside the stream window degrade to the graph's own data.
        Commit? full;
        for (final c in vm.commits) {
          if (c.sha == g.sha) {
            full = c;
            break;
          }
        }
        final commit = full ??
            Commit(
              sha: g.sha,
              repoId: '',
              message: g.message,
              author: CommitAuthor(
                login: g.authorLogin ?? '',
                name: g.authorName,
                email: '',
              ),
              url: '',
              branch: g.primaryBranch.isEmpty ? null : g.primaryBranch,
            );
        _showCommitSheet(context, commit, vm);
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: AppDimens.spacingMd),
        // IntrinsicHeight bounds the stretch axis so the rail painter gets the
        // row's real height (a ListView child otherwise has unbounded height).
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // The rail strip is its own gesture target (inside the row's
              // InkWell so it wins the arena for this region): tapping it pops
              // up the lane→branch legend instead of opening the commit sheet.
              GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => _showLaneBranchSheet(context, row),
                child: SizedBox(
                  width: railWidth,
                  child: CustomPaint(
                    painter: _GraphLanePainter(
                      row: row,
                      laneWidth: laneWidth,
                      maxLanes: railLanes,
                      palette: _laneColors,
                      ringColor: scheme.outlineVariant,
                    ),
                  ),
                ),
              ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    vertical: AppDimens.spacingSm,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              g.message.split('\n').first,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.bodyMedium?.copyWith(
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                          if (g.isMerge && g.prNumber != null) ...[
                            const SizedBox(width: AppDimens.spacingXs),
                            _GraphChip(
                              label: '#${g.prNumber}',
                              icon: Icons.merge_outlined,
                              background: scheme.secondaryContainer,
                              foreground: scheme.onSecondaryContainer,
                            ),
                          ],
                          if (branchTip != null) ...[
                            const SizedBox(width: AppDimens.spacingXs),
                            _GraphChip(
                              label: branchTip!,
                              icon: Icons.label_outline,
                              background: color.withValues(alpha: 0.18),
                              foreground: scheme.onSurface,
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 2),
                      Row(
                        children: [
                          CircleAvatar(
                            radius: 8,
                            backgroundColor: scheme.surfaceContainerHighest,
                            foregroundImage: g.avatarUrl != null
                                ? NetworkImage(g.avatarUrl!)
                                : null,
                            child: Text(
                              (g.authorLogin ?? g.authorName).isEmpty
                                  ? '?'
                                  : (g.authorLogin ?? g.authorName)
                                      .substring(0, 1)
                                      .toUpperCase(),
                              style: theme.textTheme.labelSmall?.copyWith(
                                fontSize: 9,
                                color: scheme.onSurfaceVariant,
                              ),
                            ),
                          ),
                          const SizedBox(width: AppDimens.spacingXs),
                          Flexible(
                            child: Text(
                              '${g.authorLogin ?? g.authorName}'
                              ' · ${g.sha.length >= 7 ? g.sha.substring(0, 7) : g.sha}'
                              ' · ${_hhmm(g.committedAt)}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.labelSmall?.copyWith(
                                color: scheme.onSurfaceVariant,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
              Icon(Icons.chevron_right, size: 18, color: scheme.outline),
            ],
          ),
        ),
      ),
    );
  }
}

// Tiny inline chip for PR numbers / branch-tip labels on graph rows.
class _GraphChip extends StatelessWidget {
  const _GraphChip({
    required this.label,
    required this.icon,
    required this.background,
    required this.foreground,
  });

  final String label;
  final IconData icon;
  final Color background;
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(AppDimens.radiusSm),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 11, color: foreground),
          const SizedBox(width: 3),
          Text(
            label,
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  fontSize: 10,
                  color: foreground,
                ),
          ),
        ],
      ),
    );
  }
}

// Paints one branch-graph row: pass-through verticals, the node's own stem,
// and the half-diagonals of fork/merge edges. Diagonals meet row boundaries
// at the lane's column x, so consecutive rows form continuous curves. Each
// lane's strokes are colored by the BRANCH the line belongs to (laneBranches),
// so a branch keeps its color even when it switches lanes.
class _GraphLanePainter extends CustomPainter {
  _GraphLanePainter({
    required this.row,
    required this.laneWidth,
    required this.maxLanes,
    required this.palette,
    required this.ringColor,
  });

  final GraphRowGeometry row;
  final double laneWidth;
  final int maxLanes;
  final List<Color> palette;
  final Color ringColor;

  double _x(int lane) =>
      laneWidth / 2 + math.min(lane, maxLanes - 1) * laneWidth;

  // Color a lane by the BRANCH its line belongs to (stable across reloads);
  // fall back to the lane-index color when the branch is unknown.
  Color _colorOf(int lane) {
    final branch =
        lane < row.laneBranches.length ? row.laneBranches[lane] : null;
    if (branch != null && branch.isNotEmpty) {
      return palette[branchColorIndex(branch, palette.length)];
    }
    return palette[lane % palette.length];
  }

  // The node's own dot color keys on the commit's own branch.
  Color get _nodeColor {
    final b = row.commit.primaryBranch;
    if (b.isNotEmpty) return palette[branchColorIndex(b, palette.length)];
    return palette[row.lane % palette.length];
  }

  @override
  void paint(Canvas canvas, Size size) {
    final midY = size.height / 2;
    final nodeX = _x(row.lane);

    Paint stroke(int lane) => Paint()
      ..color = _colorOf(lane)
      ..strokeWidth = 2
      ..style = PaintingStyle.stroke;

    // Pass-through verticals.
    for (var l = 0; l < row.passThrough.length; l++) {
      if (!row.passThrough[l]) continue;
      final x = _x(l);
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), stroke(l));
    }

    // The node's own line: from the children above / down to the first parent
    // (drawn even when the parent is off-window — the history continues).
    if (row.topStem) {
      canvas.drawLine(Offset(nodeX, 0), Offset(nodeX, midY), stroke(row.lane));
    }
    if (row.bottomStem) {
      canvas.drawLine(
        Offset(nodeX, midY),
        Offset(nodeX, size.height),
        stroke(row.lane),
      );
    }

    // Merge lines converging into the node from other lanes above.
    for (final l in row.intoNode) {
      final path = Path()
        ..moveTo(_x(l), 0)
        ..quadraticBezierTo(_x(l), midY, nodeX, midY);
      canvas.drawPath(path, stroke(l));
    }
    // Fork edges leaving the node toward extra parents' lanes below.
    for (final l in row.outOfNode) {
      final path = Path()
        ..moveTo(nodeX, midY)
        ..quadraticBezierTo(_x(l), midY, _x(l), size.height);
      canvas.drawPath(path, stroke(l));
    }

    // Node dot (ring + fill); merge commits get a hollow center.
    canvas.drawCircle(Offset(nodeX, midY), 5.5, Paint()..color = ringColor);
    canvas.drawCircle(
      Offset(nodeX, midY),
      4,
      Paint()..color = _nodeColor,
    );
    if (row.commit.isMerge) {
      canvas.drawCircle(Offset(nodeX, midY), 1.8, Paint()..color = ringColor);
    }
  }

  @override
  bool shouldRepaint(_GraphLanePainter old) =>
      old.row != row ||
      old.maxLanes != maxLanes ||
      old.ringColor != ringColor;
}

// Rail-tap legend (D3): lists the branches whose lines pass through this row —
// a color dot + branch name per lane, the tapped commit's own branch first,
// deduplicated. A big tap target (the whole rail strip), no per-pixel hit test.
void _showLaneBranchSheet(BuildContext context, GraphRowGeometry row) {
  final s = context.l10n;
  final own = row.commit.primaryBranch;
  // Gather distinct branch names across the row's lanes, own branch first.
  final ordered = <String>[];
  void add(String? b) {
    if (b == null || b.isEmpty) return;
    if (!ordered.contains(b)) ordered.add(b);
  }

  add(own);
  for (final b in row.laneBranches) {
    add(b);
  }

  showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (ctx) {
      final theme = Theme.of(ctx);
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppDimens.spacingMd,
            0,
            AppDimens.spacingMd,
            AppDimens.spacingMd,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(bottom: AppDimens.spacingSm),
                child: Text(
                  s.branchesInRow,
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              if (ordered.isEmpty)
                Text(
                  s.noBranchInfo,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                )
              else
                for (final b in ordered)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Row(
                      children: [
                        Container(
                          width: 12,
                          height: 12,
                          decoration: BoxDecoration(
                            color: _BranchGraphRow.branchColor(b),
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: AppDimens.spacingSm),
                        Expanded(
                          child: Text(
                            b,
                            style: theme.textTheme.bodyMedium?.copyWith(
                              fontWeight: b == own
                                  ? FontWeight.w700
                                  : FontWeight.w400,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
            ],
          ),
        ),
      );
    },
  );
}

// Bottom sheet: commit details + the AI work explanation (auto-fetched, cached
// by the VM and on the backend commit doc).
void _showCommitSheet(
  BuildContext context,
  Commit commit,
  CommitsViewModel vm,
) {
  // Kick off the explanation fetch before the sheet builds — in the app's
  // language so the FIRST tap (not just a regenerate) comes back localized.
  vm.explain(commit.sha, language: context.l10n.backendLanguage);
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => ChangeNotifierProvider<CommitsViewModel>.value(
      value: vm,
      child: _CommitDetailSheet(commit: commit),
    ),
  );
}

class _CommitDetailSheet extends StatelessWidget {
  const _CommitDetailSheet({required this.commit});
  final Commit commit;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final c = commit;
    return Consumer<CommitsViewModel>(
      builder: (ctx, vm, _) {
        final explanation = vm.explanationFor(c.sha);
        final explaining = vm.isExplaining(c.sha);
        return DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.6,
          maxChildSize: 0.92,
          builder: (_, scrollController) => ListView(
            controller: scrollController,
            padding: const EdgeInsets.fromLTRB(
              AppDimens.spacingMd,
              0,
              AppDimens.spacingMd,
              AppDimens.spacingMd,
            ),
            children: [
              Text(
                c.message.split('\n').first,
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: AppDimens.spacingXs),
              Text(
                '${c.author.name.isEmpty ? c.author.login : c.author.name}'
                ' · ${c.sha.length >= 7 ? c.sha.substring(0, 7) : c.sha}'
                ' · +${c.additions} −${c.deletions}',
                style: theme.textTheme.labelMedium?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
              if (c.branch != null && c.branch!.isNotEmpty) ...[
                const SizedBox(height: AppDimens.spacingXs),
                Row(
                  children: [
                    Container(
                      width: 10,
                      height: 10,
                      decoration: BoxDecoration(
                        color: _BranchGraphRow.branchColor(c.branch!),
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: AppDimens.spacingXs),
                    Text(
                      c.branch!,
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ],
              if (c.filesChanged.isNotEmpty) ...[
                const SizedBox(height: AppDimens.spacingSm),
                Wrap(
                  spacing: AppDimens.spacingXs,
                  runSpacing: AppDimens.spacingXs,
                  children: [
                    for (final f in c.filesChanged.take(8))
                      Chip(
                        label: Text(f, style: theme.textTheme.labelSmall),
                        visualDensity: VisualDensity.compact,
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                  ],
                ),
              ],
              const SizedBox(height: AppDimens.spacingMd),
              Row(
                children: [
                  Icon(
                    Icons.auto_awesome_outlined,
                    size: 18,
                    color: scheme.primary,
                  ),
                  const SizedBox(width: AppDimens.spacingSm),
                  Text(
                    s.aiWorkSummary,
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Spacer(),
                  if (explanation != null && !explaining)
                    IconButton(
                      tooltip: s.regenerate,
                      onPressed: () => vm.explain(
                        c.sha,
                        force: true,
                        language: s.backendLanguage,
                      ),
                      icon: const Icon(Icons.refresh, size: 18),
                    ),
                ],
              ),
              const SizedBox(height: AppDimens.spacingSm),
              if (explaining)
                // Live agent "thinking" steps (reading nearby commits,
                // searching Discord, writing) while the callable runs.
                Padding(
                  padding: const EdgeInsets.symmetric(
                    vertical: AppDimens.spacingSm,
                  ),
                  child: AskRepoLiveTraceStrip(steps: vm.liveSteps),
                )
              else if (explanation != null)
                MarkdownView(data: explanation)
              else if (vm.explainError != null)
                Text(
                  s.couldNotGenerateSummary,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: scheme.error,
                  ),
                )
              else
                const SizedBox.shrink(),
            ],
          ),
        );
      },
    );
  }
}

// `YYYY-MM-DD` key for a date (used in the range SnackBar).
String _dayKey(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-'
    '${d.month.toString().padLeft(2, '0')}-'
    '${d.day.toString().padLeft(2, '0')}';

// `MM/dd` for a date (used in the compact range button label).
String _monthDay(DateTime d) =>
    '${d.month.toString().padLeft(2, '0')}/${d.day.toString().padLeft(2, '0')}';

// Date-range button label: shows the saved range, the busy state, or a prompt.
String _rangeLabel(DiscordMessagesViewModel vm, AppStrings s) {
  if (vm.settingRange) return s.saving;
  final start = vm.rangeStart;
  final end = vm.rangeEnd;
  if (start != null && end != null) {
    return '${_monthDay(start)} ~ ${_monthDay(end)}';
  }
  return s.dateRangeLabel;
}

// Discord tab — a collapsible, fixed-height digest panel (mirrors the Summary
// tab's day-report panel, D4) on top, and the AI chat over the team's Discord
// messages below. The shared AppBar Refresh fills the window's digests; the
// shared range scopes both the digest display and the chat reads. No per-tab
// refresh / date / backfill controls (D3) — just a read-only scope label.
class _DiscordTab extends StatefulWidget {
  const _DiscordTab();

  @override
  State<_DiscordTab> createState() => _DiscordTabState();
}

class _DiscordTabState extends State<_DiscordTab> {
  // Whether the upper digest panel is expanded. Collapsed shows just its header
  // row, giving the chat the full height.
  bool _digestExpanded = true;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    return Consumer<DiscordMessagesViewModel>(
      builder: (ctx, vm, _) {
        if (vm.loading) {
          return const Center(child: CircularProgressIndicator());
        }
        // Show a one-shot "Updated" toast once a refresh round-trip completes.
        if (vm.justUpdated) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (!ctx.mounted) return;
            vm.acknowledgeUpdated();
            ScaffoldMessenger.of(
              ctx,
            ).showSnackBar(SnackBar(content: Text(s.updated)));
          });
        }
        // Cap the digest panel at ~45% of the viewport so many days never push
        // the chat off screen — it scrolls internally instead (D4).
        final panelMaxHeight = MediaQuery.of(ctx).size.height * 0.45;
        return Column(
          children: [
            _DigestPanel(
              vm: vm,
              expanded: _digestExpanded,
              maxHeight: panelMaxHeight,
              onToggle: () =>
                  setState(() => _digestExpanded = !_digestExpanded),
            ),
            const Divider(height: 1),
            const Expanded(child: _DiscordChat()),
          ],
        );
      },
    );
  }
}

// D4: the upper digest panel. A tappable header row ('Discord digest' + day
// count + chevron) collapses/expands the whole panel; when expanded the per-day
// digest cards live in a fixed-height, internally scrollable region. Mirrors
// _ReportsPanel. The per-day _DigestCards are unchanged inside.
class _DigestPanel extends StatefulWidget {
  const _DigestPanel({
    required this.vm,
    required this.expanded,
    required this.maxHeight,
    required this.onToggle,
  });

  final DiscordMessagesViewModel vm;
  final bool expanded;
  final double maxHeight;
  final VoidCallback onToggle;

  @override
  State<_DigestPanel> createState() => _DigestPanelState();
}

class _DigestPanelState extends State<_DigestPanel> {
  final ScrollController _scrollController = ScrollController();

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final vm = widget.vm;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          expanded: widget.expanded,
          button: true,
          label: s.discordDigest,
          child: InkWell(
          onTap: widget.onToggle,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              AppDimens.spacingMd,
              AppDimens.spacingSm,
              AppDimens.spacingSm,
              AppDimens.spacingSm,
            ),
            child: Row(
              children: [
                Icon(Icons.forum_outlined, size: 20, color: scheme.primary),
                const SizedBox(width: AppDimens.spacingSm),
                Text(
                  s.discordDigest,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(width: AppDimens.spacingSm),
                _CountChip(
                  icon: Icons.calendar_today_outlined,
                  label: '${vm.digests.length}',
                ),
                const SizedBox(width: AppDimens.spacingSm),
                // Read-only scope label — the saved backfill range (or a "saving"
                // spinner). Refresh + range are now the shared AppBar actions.
                if (vm.settingRange)
                  const SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                else
                  Flexible(
                    child: Text(
                      _rangeLabel(vm, s),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                const Spacer(),
                AnimatedRotation(
                  turns: widget.expanded ? 0.5 : 0,
                  duration: AppMotion.short,
                  child: const Icon(Icons.expand_more),
                ),
              ],
            ),
          ),
        ),
        ),
        if (widget.expanded)
          ConstrainedBox(
            constraints: BoxConstraints(maxHeight: widget.maxHeight),
            child: vm.digests.isEmpty
                ? Padding(
                    padding: const EdgeInsets.fromLTRB(
                      AppDimens.spacingMd,
                      0,
                      AppDimens.spacingMd,
                      AppDimens.spacingMd,
                    ),
                    child: Text(
                      s.noDigestInRange,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  )
                // Scrollbar pinned flush to the panel's far-right edge: the
                // ListView carries no right padding, so the scrollbar gutter sits
                // at the outermost right. Each child gets its own right inset.
                : Scrollbar(
                    controller: _scrollController,
                    thumbVisibility: true,
                    child: ListView(
                      controller: _scrollController,
                      padding: const EdgeInsets.fromLTRB(
                        AppDimens.spacingMd,
                        0,
                        0,
                        AppDimens.spacingMd,
                      ),
                      shrinkWrap: true,
                      children: [
                        // One digest card per day in the visible window that HAS
                        // a digest doc (newest first). Days without a digest are
                        // skipped.
                        for (var i = 0; i < vm.digests.length; i++) ...[
                          Padding(
                            padding: const EdgeInsets.only(
                              right: AppDimens.spacingSm,
                            ),
                            child: _DigestCard(
                              key: ValueKey(vm.digests[i].date),
                              digest: vm.digests[i],
                              vm: vm,
                              // Newest day expanded by default, older collapsed.
                              initiallyExpanded: i == 0,
                            ),
                          ),
                          const SizedBox(height: AppDimens.spacingMd),
                        ],
                      ],
                    ),
                  ),
          ),
      ],
    );
  }
}

/// The messages a digest references, with timestamps. Prefers the set the
/// backend persisted on the digest doc (`sourceMessages`); for older digests
/// written before that field existed, falls back to the day's streamed messages
/// (filtered to the digest's Asia/Taipei day) so the panel still appears. Capped
/// to keep the list bounded.
List<DiscordDigestSource> _digestSources(
  DiscordDigest digest,
  DiscordMessagesViewModel vm,
) {
  if (digest.sourceMessages.isNotEmpty) return digest.sourceMessages;
  String taipeiKey(DateTime ts) {
    final t = ts.toUtc().add(const Duration(hours: 8));
    String two(int n) => n.toString().padLeft(2, '0');
    return '${t.year}-${two(t.month)}-${two(t.day)}';
  }
  final sameDay = vm.messages
      .where((m) => taipeiKey(m.timestamp.toDate()) == digest.date)
      .toList()
    ..sort((a, b) => a.timestamp.compareTo(b.timestamp));
  return sameDay
      .take(50)
      .map((m) => DiscordDigestSource(
            authorName: m.authorName,
            content: m.content,
            timestamp: m.timestamp.toDate().toLocal(),
          ))
      .toList();
}

// Collapsible "referenced messages" list under a digest: the messages the
// summary was built from, each with its send time, so the user can see what was
// discussed and WHEN (not just the outline). Collapsed by default.
class _DigestSourceMessages extends StatelessWidget {
  const _DigestSourceMessages({required this.sources});
  final List<DiscordDigestSource> sources;

  static String _stamp(DateTime? dt) {
    if (dt == null) return '';
    final d = dt.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${d.year}/${two(d.month)}/${two(d.day)} ${two(d.hour)}:${two(d.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Theme(
      // Strip the default ExpansionTile dividers so it sits flush in the card.
      data: theme.copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        tilePadding: EdgeInsets.zero,
        childrenPadding: const EdgeInsets.only(bottom: AppDimens.spacingSm),
        // ExpansionTile centers its children by default — left-align them.
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        expandedAlignment: Alignment.centerLeft,
        dense: true,
        leading: Icon(Icons.forum_outlined, size: 16, color: scheme.secondary),
        title: Text(
          s.digestSourceMessages(sources.length),
          style: theme.textTheme.labelMedium?.copyWith(
            fontWeight: FontWeight.w600,
          ),
        ),
        children: [
          for (final m in sources)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: RichText(
                text: TextSpan(
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: scheme.onSurfaceVariant),
                  children: [
                    if (_stamp(m.timestamp).isNotEmpty)
                      TextSpan(
                        text: '${_stamp(m.timestamp)}  ',
                        style: theme.textTheme.labelSmall
                            ?.copyWith(color: scheme.onSurfaceVariant),
                      ),
                    TextSpan(
                      text: '${m.authorName}: ',
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                    TextSpan(text: m.content),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

// collapse/expand; the lock button animates; the card border animates to a
// "frozen" tint when locked.
class _DigestCard extends StatefulWidget {
  const _DigestCard({
    super.key,
    required this.digest,
    required this.vm,
    this.initiallyExpanded = true,
  });
  final DiscordDigest digest;
  final DiscordMessagesViewModel vm;
  final bool initiallyExpanded;

  @override
  State<_DigestCard> createState() => _DigestCardState();
}

class _DigestCardState extends State<_DigestCard> {
  late bool _expanded = widget.initiallyExpanded;
  final _adjustController = TextEditingController();

  @override
  void dispose() {
    _adjustController.dispose();
    super.dispose();
  }

  void _submitAdjust() {
    final text = _adjustController.text;
    if (text.trim().isEmpty || widget.vm.isEditingDigest(widget.digest.date)) {
      return;
    }
    _adjustController.clear();
    widget.vm.editDigest(widget.digest.date, text);
  }

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final digest = widget.digest;
    final vm = widget.vm;
    final locked = digest.locked;
    final editing = vm.isEditingDigest(digest.date);
    final toggling = vm.isTogglingLock(digest.date);

    return AnimatedContainer(
      duration: AppMotion.medium,
      curve: AppMotion.emphasizedDecel,
      decoration: BoxDecoration(
        color: theme.brightness == Brightness.light
            ? const Color(0xFFFFFFFF)
            : scheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(AppDimens.radiusMd),
        border: Border.all(
          color: locked
              ? scheme.primary
              : scheme.outlineVariant.withValues(alpha: 0.4),
          width: locked ? 1.6 : 1,
        ),
        boxShadow: [
          BoxShadow(
            color: scheme.shadow.withValues(alpha: 0.06),
            blurRadius: 6,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // ---- Header (tap to collapse/expand) ----
          Semantics(
            expanded: _expanded,
            button: true,
            child: InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            borderRadius: BorderRadius.circular(AppDimens.radiusMd),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(
                AppDimens.spacingMd,
                AppDimens.spacingSm,
                AppDimens.spacingSm,
                AppDimens.spacingSm,
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.auto_awesome_outlined,
                    size: 20,
                    color: scheme.primary,
                  ),
                  const SizedBox(width: AppDimens.spacingSm),
                  Text(
                    s.discordDigestForDate(digest.date),
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  if (locked) ...[
                    const SizedBox(width: AppDimens.spacingSm),
                    Icon(Icons.lock, size: 16, color: scheme.primary),
                  ],
                  const Spacer(),
                  // Animated lock toggle.
                  IconButton(
                    tooltip: locked ? s.unlockDigest : s.lockDigest,
                    onPressed: toggling ? null : () => vm.toggleLock(digest),
                    icon: toggling
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : AnimatedSwitcher(
                            duration: AppMotion.medium,
                            transitionBuilder: (child, anim) => ScaleTransition(
                              scale: anim,
                              child: RotationTransition(
                                turns: anim,
                                child: child,
                              ),
                            ),
                            child: Icon(
                              locked ? Icons.lock : Icons.lock_open,
                              key: ValueKey(locked),
                              color: locked ? scheme.primary : null,
                            ),
                          ),
                  ),
                  // Animated collapse chevron.
                  AnimatedRotation(
                    turns: _expanded ? 0.5 : 0,
                    duration: AppMotion.short,
                    child: const Icon(Icons.expand_more),
                  ),
                ],
              ),
            ),
          ),
          ),
          // ---- Collapsible body ----
          AnimatedSize(
            duration: AppMotion.short,
            curve: AppMotion.emphasizedDecel,
            alignment: Alignment.topCenter,
            child: _expanded
                ? Padding(
                    padding: const EdgeInsets.fromLTRB(
                      AppDimens.spacingMd,
                      0,
                      AppDimens.spacingMd,
                      AppDimens.spacingMd,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // Render the full digest inline and let the enclosing
                        // panel ListView own the scroll. (A nested same-axis
                        // SingleChildScrollView here captured vertical drags, so
                        // the panel couldn't scroll past a long digest and the
                        // card's bottom — adjust field, trace — was unreachable.)
                        SizedBox(
                          width: double.infinity,
                          child: MarkdownView(data: digest.markdown),
                        ),
                        // The messages this digest references. Prefer the set
                        // the backend persisted with the digest; for older
                        // digests written before that existed, fall back to the
                        // day's streamed messages so the panel still shows.
                        if (_digestSources(digest, vm).isNotEmpty) ...[
                          const SizedBox(height: AppDimens.spacingSm),
                          _DigestSourceMessages(
                            sources: _digestSources(digest, vm),
                          ),
                        ],
                        const SizedBox(height: AppDimens.spacingSm),
                        const Divider(height: 1),
                        const SizedBox(height: AppDimens.spacingSm),
                        if (locked)
                          Row(
                            children: [
                              Icon(
                                Icons.lock_outline,
                                size: 16,
                                color: scheme.outline,
                              ),
                              const SizedBox(width: AppDimens.spacingXs),
                              Expanded(
                                child: Text(
                                  s.digestLockedHint,
                                  style: theme.textTheme.bodySmall?.copyWith(
                                    color: scheme.outline,
                                  ),
                                ),
                              ),
                            ],
                          )
                        else
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Expanded(
                                child: TextField(
                                  controller: _adjustController,
                                  minLines: 1,
                                  maxLines: 3,
                                  enabled: !editing,
                                  textInputAction: TextInputAction.send,
                                  onSubmitted: (_) => _submitAdjust(),
                                  decoration: InputDecoration(
                                    hintText: s.adjustSummaryHint,
                                    border: const OutlineInputBorder(),
                                    isDense: true,
                                  ),
                                ),
                              ),
                              const SizedBox(width: AppDimens.spacingSm),
                              IconButton.filledTonal(
                                tooltip: s.adjustWithAi,
                                onPressed: editing ? null : _submitAdjust,
                                icon: editing
                                    ? const SizedBox(
                                        width: 18,
                                        height: 18,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                        ),
                                      )
                                    : const Icon(Icons.auto_fix_high),
                              ),
                            ],
                          ),
                        if (editing) ...[
                          const SizedBox(height: AppDimens.spacingXs),
                          // Live agent "thinking" steps while the digest is
                          // rewritten (searching Discord, revising…).
                          AskRepoLiveTraceStrip(steps: vm.liveSteps),
                        ],
                        if (vm.digestError != null) ...[
                          const SizedBox(height: AppDimens.spacingXs),
                          Text(
                            s.couldNotUpdateDigest,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: scheme.error,
                            ),
                          ),
                        ],
                      ],
                    ),
                  )
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }
}

// AI chat box over the team's Discord messages. The user asks questions; the
// backend `discordChat` callable searches the ingested messages and answers.
// Each AI answer embeds a scrollable panel of the messages it surfaced.
class _DiscordChat extends StatefulWidget {
  const _DiscordChat();

  @override
  State<_DiscordChat> createState() => _DiscordChatState();
}

class _DiscordChatState extends State<_DiscordChat> {
  final _controller = TextEditingController();
  final _scrollController = ScrollController();

  @override
  void dispose() {
    _controller.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _send(DiscordChatViewModel vm) {
    final text = _controller.text;
    if (text.trim().isEmpty || vm.sending) return;
    _controller.clear();
    vm.ask(text);
    // Jump to the latest turn once the frame with it is laid out.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: AppMotion.medium,
        curve: AppMotion.emphasizedDecel,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    return Consumer<DiscordChatViewModel>(
      builder: (ctx, vm, _) {
        final turns = vm.turns;
        return Column(
          children: [
            Expanded(
              // Make the empty state scroll-safe: in a small/short window the
              // chat's Expanded can shrink below the EmptyState's natural
              // height, which would overflow a plain Column. LayoutBuilder +
              // SingleChildScrollView keeps it centered when there's room and
              // scrollable when there isn't.
              child: turns.isEmpty
                  ? LayoutBuilder(
                      builder: (ctx, constraints) => SingleChildScrollView(
                        child: ConstrainedBox(
                          constraints: BoxConstraints(
                            minHeight: constraints.maxHeight,
                          ),
                          child: Center(
                            child: EmptyState(
                              icon: Icons.auto_awesome_outlined,
                              title: s.askAiAboutChat,
                              message: s.askAiAboutChatHint,
                            ),
                          ),
                        ),
                      ),
                    )
                  : ListView.builder(
                      controller: _scrollController,
                      padding: const EdgeInsets.all(AppDimens.spacingMd),
                      itemCount: turns.length + 1 + (vm.sending ? 1 : 0),
                      itemBuilder: (_, i) {
                        if (i == 0) {
                          return Padding(
                            padding: const EdgeInsets.only(
                              bottom: AppDimens.spacingSm,
                            ),
                            child: Text(
                              s.askDiscordScope,
                              style: Theme.of(ctx).textTheme.bodySmall?.copyWith(
                                color: Theme.of(ctx).colorScheme.onSurfaceVariant,
                              ),
                            ),
                          );
                        }
                        final ti = i - 1;
                        if (ti >= turns.length) {
                          // Live agent trace (searching Discord, composing…)
                          // replaces the generic "thinking" bubble.
                          return AskRepoLiveTraceStrip(steps: vm.liveSteps);
                        }
                        return _ChatTurnView(turn: turns[ti]);
                      },
                    ),
            ),
            _ChatInputBar(
              controller: _controller,
              sending: vm.sending,
              onSend: () => _send(vm),
              onNewSession: vm.sending ? null : vm.newSession,
            ),
          ],
        );
      },
    );
  }
}

// Two-digit `HH:mm` for a chat-bubble timestamp.
String _hhmm(DateTime t) =>
    '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

// `MM/dd HH:mm` from a Discord message's ISO 8601 timestamp (shown local). Falls
// back to the raw string if unparseable, or '' when there is none.
String _sourceTime(String? iso) {
  if (iso == null || iso.isEmpty) return '';
  final parsed = DateTime.tryParse(iso);
  if (parsed == null) return iso;
  final t = parsed.toLocal();
  return '${t.month.toString().padLeft(2, '0')}/${t.day.toString().padLeft(2, '0')} '
      '${_hhmm(t)}';
}

class _ChatTurnView extends StatelessWidget {
  const _ChatTurnView({required this.turn});
  final DiscordChatTurn turn;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    if (turn.isUser) {
      return Padding(
        padding: const EdgeInsets.only(bottom: AppDimens.spacingMd),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Container(
              constraints: const BoxConstraints(maxWidth: 520),
              padding: const EdgeInsets.symmetric(
                horizontal: AppDimens.spacingMd,
                vertical: AppDimens.spacingSm,
              ),
              decoration: BoxDecoration(
                color: scheme.primaryContainer,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Text(
                turn.content,
                style: TextStyle(color: scheme.onPrimaryContainer),
              ),
            ),
            if (turn.createdAt != null)
              Padding(
                padding: const EdgeInsets.only(top: 2, right: 4),
                child: Text(
                  _hhmm(turn.createdAt!),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ),
          ],
        ),
      );
    }

    // Assistant turn: markdown answer + (optional) scrollable sources panel.
    return Padding(
      padding: const EdgeInsets.only(bottom: AppDimens.spacingMd),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.auto_awesome_outlined,
                size: 18,
                color: scheme.primary,
              ),
              const SizedBox(width: AppDimens.spacingSm),
              Text(
                'AI',
                style: theme.textTheme.labelLarge?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (turn.createdAt != null) ...[
                const SizedBox(width: AppDimens.spacingSm),
                Text(
                  _hhmm(turn.createdAt!),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: AppDimens.spacingSm),
          MarkdownView(data: turn.content),
          if (turn.snippets.isNotEmpty) ...[
            const SizedBox(height: AppDimens.spacingSm),
            _SourcesPanel(snippets: turn.snippets),
          ],
        ],
      ),
    );
  }
}

// Scrollable panel of the conversation clusters the AI surfaced for an answer
// — the "relevant chat content in the middle that the user can scroll" (D4).
// Each snippet is one cluster: chronological messages with the matched line(s)
// emphasized and surrounding context dimmed; clusters are split by a divider.
class _SourcesPanel extends StatelessWidget {
  const _SourcesPanel({required this.snippets});
  final List<DiscordChatSnippet> snippets;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Container(
      constraints: const BoxConstraints(maxHeight: 260),
      decoration: BoxDecoration(
        border: Border.all(color: scheme.outlineVariant),
        borderRadius: BorderRadius.circular(12),
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.4),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppDimens.spacingMd,
              AppDimens.spacingSm,
              AppDimens.spacingMd,
              AppDimens.spacingXs,
            ),
            child: Row(
              children: [
                Icon(Icons.forum_outlined, size: 16, color: scheme.secondary),
                const SizedBox(width: AppDimens.spacingXs),
                Text(
                  s.relatedConversations(snippets.length),
                  style: theme.textTheme.labelMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
          Flexible(
            child: ListView.separated(
              padding: const EdgeInsets.fromLTRB(
                AppDimens.spacingMd,
                0,
                AppDimens.spacingMd,
                AppDimens.spacingSm,
              ),
              shrinkWrap: true,
              itemCount: snippets.length,
              // Visible divider so distinct conversations read as separate
              // clusters.
              separatorBuilder: (_, _) => const Padding(
                padding: EdgeInsets.symmetric(vertical: AppDimens.spacingSm),
                child: Divider(height: 1),
              ),
              itemBuilder: (_, i) => _SnippetBlock(snippet: snippets[i]),
            ),
          ),
        ],
      ),
    );
  }
}

// One conversation cluster: its messages in chronological order. Matched
// messages are emphasized (subtle highlight + leading marker); context
// messages are dimmed.
class _SnippetBlock extends StatelessWidget {
  const _SnippetBlock({required this.snippet});
  final DiscordChatSnippet snippet;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < snippet.messages.length; i++) ...[
          if (i > 0) const SizedBox(height: AppDimens.spacingXs),
          _SnippetMessage(source: snippet.messages[i]),
        ],
      ],
    );
  }
}

class _SnippetMessage extends StatelessWidget {
  const _SnippetMessage({required this.source});
  final DiscordChatSource source;

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final s = source;
    final time = _sourceTime(s.timestamp);
    // Matched line: full-strength text with a highlight; context: dimmed.
    final authorColor = s.isMatch ? scheme.primary : scheme.onSurfaceVariant;
    final contentStyle = theme.textTheme.bodySmall?.copyWith(
      color: s.isMatch ? scheme.onSurface : scheme.onSurfaceVariant,
    );

    final row = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            if (s.isMatch) ...[
              Icon(Icons.arrow_right, size: 14, color: scheme.primary),
              const SizedBox(width: 2),
            ],
            Flexible(
              child: Text(
                s.authorName.isEmpty ? l.unknownAuthor : s.authorName,
                style: theme.textTheme.labelSmall?.copyWith(
                  fontWeight: s.isMatch ? FontWeight.w700 : FontWeight.w600,
                  color: authorColor,
                ),
              ),
            ),
            if (time.isNotEmpty) ...[
              const SizedBox(width: AppDimens.spacingSm),
              Text(
                time,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
        Text(s.content, style: contentStyle),
      ],
    );

    if (!s.isMatch) return row;
    // Subtle highlighted background for the matched message(s).
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: AppDimens.spacingXs,
        vertical: 2,
      ),
      decoration: BoxDecoration(
        color: scheme.primaryContainer.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(6),
      ),
      child: row,
    );
  }
}

class _ChatInputBar extends StatelessWidget {
  const _ChatInputBar({
    required this.controller,
    required this.sending,
    required this.onSend,
    required this.onNewSession,
  });

  final TextEditingController controller;
  final bool sending;
  final VoidCallback onSend;

  /// Clears the conversation to start a fresh session (D5). Null disables it
  /// (e.g. while a question is in flight).
  final VoidCallback? onNewSession;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final scheme = Theme.of(context).colorScheme;
    return Material(
      elevation: 2,
      color: scheme.surface,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppDimens.spacingMd,
          AppDimens.spacingSm,
          AppDimens.spacingMd,
          AppDimens.spacingMd,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            // Start a new chat session — clears the transcript (D5).
            IconButton(
              tooltip: s.newSession,
              onPressed: sending ? null : onNewSession,
              icon: const Icon(Icons.restart_alt),
            ),
            Expanded(
              child: TextField(
                controller: controller,
                minLines: 1,
                maxLines: 4,
                textInputAction: TextInputAction.send,
                enabled: !sending,
                onSubmitted: (_) => onSend(),
                decoration: InputDecoration(
                  hintText: s.askAiDiscordHint,
                  border: const OutlineInputBorder(),
                  isDense: true,
                ),
              ),
            ),
            const SizedBox(width: AppDimens.spacingSm),
            IconButton.filled(
              onPressed: sending ? null : onSend,
              icon: sending
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.send),
            ),
          ],
        ),
      ),
    );
  }
}

// [feat] 進度表：顯示每個人當前認領且尚未完成的任務進度。
