import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_strings.dart';
import '../../theme/app_dimens.dart';
import '../../view_models/members_vm.dart';
import '../../widgets/section_card.dart';
import '../../view_models/stats_vm.dart';
import '../../view_models/tasks_board_vm.dart';
import '../../widgets/markdown_view.dart';

// StatsViewPage — faithful rebuild of the design prototype's two-tab Stats
// screen (StatsView.tsx): a 貢獻度 contribution pie and a 進度表 per-member
// progress table with expandable task lists. Derived purely from tasks +
// members via StatsViewModel (no commits — the prototype has none).
class StatsViewPage extends StatelessWidget {
  const StatsViewPage({super.key, required this.repoId});
  final String repoId;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    return ChangeNotifierProxyProvider2<TasksBoardViewModel, MembersViewModel,
        StatsViewModel>(
      create: (_) => StatsViewModel(repoId: repoId),
      update: (_, tasks, members, prev) =>
          (prev ?? StatsViewModel(repoId: repoId))
            ..updateFromUpstream(tasks: tasks, members: members),
      child: DefaultTabController(
        length: 2,
        child: Scaffold(
          appBar: AppBar(
            title: Text(s.statsTitle),
            bottom: PreferredSize(
              preferredSize: const Size.fromHeight(kTextTabBarHeight + 1),
              child: Column(
                children: [
                  const Divider(height: 1),
                  TabBar(
                    tabs: [
                      Tab(text: s.contributionTab),
                      Tab(text: s.progressTab),
                    ],
                  ),
                ],
              ),
            ),
          ),
          body: Consumer<StatsViewModel>(
            builder: (ctx, vm, _) {
              return TabBarView(
                children: [
                  _ContributionTab(vm: vm),
                  _ProgressTab(vm: vm),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

// ---- Tab 1: 貢獻度 (contribution pie) --------------------------------------

/// Which basis the 貢獻度 pie is computed from.
enum _ContributionBasis { commit, task }

class _ContributionTab extends StatefulWidget {
  const _ContributionTab({required this.vm});
  final StatsViewModel vm;

  @override
  State<_ContributionTab> createState() => _ContributionTabState();
}

class _ContributionTabState extends State<_ContributionTab> {
  // Default to the commit basis — the all-history commit share is the headline
  // the user asked for.
  _ContributionBasis _basis = _ContributionBasis.commit;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final scheme = Theme.of(context).colorScheme;
    final vm = widget.vm;

    final isCommit = _basis == _ContributionBasis.commit;
    final contributions =
        isCommit ? vm.commitContributions : vm.contributions;
    final caption = isCommit
        ? s.commitContributionCaption
        : s.taskContributionCaption;

    final toggle = Padding(
      padding: const EdgeInsets.only(bottom: AppDimens.spacingMd),
      child: Center(
        child: SegmentedButton<_ContributionBasis>(
          showSelectedIcon: false,
          segments: [
            ButtonSegment(
              value: _ContributionBasis.commit,
              label: Text(s.contributionBasisCommit),
            ),
            ButtonSegment(
              value: _ContributionBasis.task,
              label: Text(s.contributionBasisTask),
            ),
          ],
          selected: {_basis},
          onSelectionChanged: (s) => setState(() => _basis = s.first),
        ),
      ),
    );

    // Commit basis is still loading its one-shot fetch.
    if (isCommit && vm.commitsLoading) {
      return ListView(
        padding: const EdgeInsets.all(AppDimens.spacingMd),
        children: [
          toggle,
          const Padding(
            padding: EdgeInsets.all(AppDimens.spacingLg),
            child: Center(child: CircularProgressIndicator()),
          ),
        ],
      );
    }

    if (contributions.isEmpty) {
      return ListView(
        padding: const EdgeInsets.all(AppDimens.spacingMd),
        children: [
          toggle,
          _EmptyHint(isCommit ? s.noCommitRecords : s.noDoneTasks),
        ],
      );
    }

    final palette = _categoricalPalette(scheme);
    final colored = [
      for (var i = 0; i < contributions.length; i++)
        (item: contributions[i], color: palette[i % palette.length]),
    ];

    return ListView(
      padding: const EdgeInsets.all(AppDimens.spacingMd),
      children: [
        toggle,
        SectionCard(
          child: Column(
            children: [
              SizedBox(
                height: 240,
                width: 240,
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    PieChart(
                      PieChartData(
                        sectionsSpace: 2,
                        centerSpaceRadius: 28,
                        sections: [
                          for (final c in colored)
                            PieChartSectionData(
                              value: c.item.doneCount.toDouble(),
                              color: c.color,
                              radius: 90,
                              // D2: no in-slice titles — the legend below
                              // carries every author name + share.
                              showTitle: false,
                            ),
                        ],
                      ),
                    ),
                    Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          s.contributionTab,
                          style: Theme.of(context)
                              .textTheme
                              .labelMedium
                              ?.copyWith(
                                color: scheme.onSurface,
                                fontWeight: FontWeight.w600,
                              ),
                        ),
                        Text(
                          s.pieChart,
                          style: Theme.of(context)
                              .textTheme
                              .labelSmall
                              ?.copyWith(color: scheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: AppDimens.spacingMd),
              Wrap(
                alignment: WrapAlignment.center,
                spacing: AppDimens.spacingMd,
                runSpacing: AppDimens.spacingXs,
                children: [
                  for (final c in colored)
                    _LegendDot(
                      color: c.color,
                      label: '${c.item.label} — ${c.item.pct}%',
                    ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: AppDimens.spacingMd),
        _CaptionCard(caption),
      ],
    );
  }
}

// ---- Tab 2: 進度表 (per-author AI work summaries) --------------------------

class _ProgressTab extends StatelessWidget {
  const _ProgressTab({required this.vm});
  final StatsViewModel vm;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final scheme = Theme.of(context).colorScheme;

    if (vm.commitsLoading) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(AppDimens.spacingLg),
          child: CircularProgressIndicator(),
        ),
      );
    }

    final authors = vm.authorGroups;
    if (authors.isEmpty) {
      return _EmptyHint(s.noCommitRecords);
    }

    final palette = _categoricalPalette(scheme);

    return ListView(
      padding: const EdgeInsets.all(AppDimens.spacingMd),
      children: [
        SectionCard(
          child: Column(
            children: [
              for (var i = 0; i < authors.length; i++) ...[
                if (i > 0) const SizedBox(height: AppDimens.spacingMd),
                _AuthorSummaryRow(
                  vm: vm,
                  author: authors[i],
                  color: palette[i % palette.length],
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: AppDimens.spacingMd),
        _CaptionCard(s.authorContributionCaption),
      ],
    );
  }
}

class _AuthorSummaryRow extends StatefulWidget {
  const _AuthorSummaryRow({
    required this.vm,
    required this.author,
    required this.color,
  });
  final StatsViewModel vm;
  final AuthorGroup author;
  final Color color;

  @override
  State<_AuthorSummaryRow> createState() => _AuthorSummaryRowState();
}

class _AuthorSummaryRowState extends State<_AuthorSummaryRow> {
  bool _expanded = false;

  void _toggle() {
    setState(() => _expanded = !_expanded);
    if (_expanded) {
      // First expand triggers the AI summary load (no-op if already cached).
      widget.vm.loadAuthorSummary(widget.author);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final g = widget.author;
    final key = g.key;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Expanded(
              child: Text(
                g.label,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: scheme.primary,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            Text(
              '${g.commitCount} commits · ${g.pct}%',
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
        const SizedBox(height: AppDimens.spacingSm),
        ClipRRect(
          borderRadius: BorderRadius.circular(AppDimens.radiusSm),
          child: LinearProgressIndicator(
            value: g.pct / 100,
            minHeight: 8,
            color: widget.color,
            backgroundColor: scheme.surfaceContainerHighest,
          ),
        ),
        const SizedBox(height: AppDimens.spacingXs),
        InkWell(
          onTap: _toggle,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: AppDimens.spacingXs),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  _expanded ? Icons.expand_more : Icons.chevron_right,
                  size: 16,
                  color: scheme.onSurfaceVariant,
                ),
                const SizedBox(width: AppDimens.spacingXs),
                Text(
                  s.statsDetails,
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
        ),
        if (_expanded)
          Padding(
            padding: const EdgeInsets.only(
              left: AppDimens.spacingSm,
              top: AppDimens.spacingXs,
            ),
            child: _AuthorSummaryBody(vm: widget.vm, author: g, summaryKey: key),
          ),
      ],
    );
  }
}

class _AuthorSummaryBody extends StatelessWidget {
  const _AuthorSummaryBody({
    required this.vm,
    required this.author,
    required this.summaryKey,
  });
  final StatsViewModel vm;
  final AuthorGroup author;
  final String summaryKey;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    if (vm.isSummarizing(summaryKey)) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: AppDimens.spacingSm),
        child: Row(
          children: [
            const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: AppDimens.spacingSm),
            Text(s.aiSummaryGenerating),
          ],
        ),
      );
    }

    final error = vm.summaryError(summaryKey);
    if (error != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: AppDimens.spacingSm),
        child: InkWell(
          onTap: () => vm.loadAuthorSummary(author, force: true),
          child: Text(
            s.summaryFailedRetry,
            style: theme.textTheme.bodySmall?.copyWith(color: scheme.error),
          ),
        ),
      );
    }

    final markdown = vm.authorSummary(summaryKey);
    if (markdown == null) {
      // Expanded but not yet requested (defensive — the row kicks off the load).
      return const SizedBox.shrink();
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                s.aiWorkSummaryTitle,
                style: theme.textTheme.labelSmall
                    ?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ),
            IconButton(
              tooltip: s.regenerate,
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.refresh, size: 16),
              onPressed: () => vm.loadAuthorSummary(author, force: true),
            ),
          ],
        ),
        MarkdownView(data: markdown),
      ],
    );
  }
}

// ---- Shared bits ------------------------------------------------------------

// A small colored dot + label, used by the pie legend.
class _LegendDot extends StatelessWidget {
  const _LegendDot({required this.color, required this.label});
  final Color color;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: AppDimens.spacingXs + 2),
        Text(label, style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}

// The caption container under each tab (e.g. 已完成的任務累計的貢獻度).
class _CaptionCard extends StatelessWidget {
  const _CaptionCard(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: AppDimens.spacingMd,
        vertical: AppDimens.spacingSm + AppDimens.spacingXs,
      ),
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
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: theme.textTheme.bodySmall
            ?.copyWith(color: scheme.onSurfaceVariant),
      ),
    );
  }
}

// Full-tab empty-state hint when there are no members/tasks for a tab.
class _EmptyHint extends StatelessWidget {
  const _EmptyHint(this.message);
  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppDimens.spacingLg),
        child: Text(
          message,
          textAlign: TextAlign.center,
          style: Theme.of(context)
              .textTheme
              .bodyMedium
              ?.copyWith(color: scheme.onSurfaceVariant),
        ),
      ),
    );
  }
}

// ---- helpers ----------------------------------------------------------------

// Ordered categorical palette derived from the theme, cycled for >N members.
// Mirrors the prototype's intent (light: a blue family; dark: the warm accent +
// blues) by sourcing from colorScheme rather than hardcoded hexes.
List<Color> _categoricalPalette(ColorScheme scheme) => [
      scheme.primary,
      scheme.tertiary,
      scheme.secondary,
      scheme.primaryContainer,
      scheme.tertiaryContainer,
      scheme.secondaryContainer,
    ];
