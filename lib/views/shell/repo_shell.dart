import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../models/task.dart';
import '../../router/shell_transitions.dart';
import '../../services/authentication.dart';
import '../../services/navigation.dart';
import '../../theme/app_motion.dart';
import '../../view_models/tasks_board_vm.dart';

// Shared shell with bottom navigation for the per-repo routes
// (tasks / daily / stats / settings). Wraps the ShellRoute child from
// `app_router.dart`.
//
// Also hosts the in-app assignment banner: it watches the repo's tasks and, when
// a task newly becomes assigned to the signed-in user, surfaces a SnackBar with
// a "View" action. This is the foreground counterpart to the FCM push (which
// covers the background/closed case) and works in both live and fake modes.
class RepoShell extends StatefulWidget {
  const RepoShell({
    super.key,
    required this.repoId,
    required this.child,
  });

  final String repoId;
  final Widget child;

  // GlobalKey preserves _SlidingBottomNavState across GoRouter rebuilds,
  // so AnimatedAlign always has a previous value to interpolate from.
  static final _navKey = GlobalKey();

  @override
  State<RepoShell> createState() => _RepoShellState();
}

class _RepoShellState extends State<RepoShell> {
  TasksBoardViewModel? _tasksVm;
  String? _uid;
  Set<String> _assignedToMe = {};
  bool _seeded = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _uid = context.read<AuthenticationService>().currentUid;
    final tasksVm = context.read<TasksBoardViewModel>();
    if (!identical(tasksVm, _tasksVm)) {
      _tasksVm?.removeListener(_onTasksChanged);
      _tasksVm = tasksVm..addListener(_onTasksChanged);
      _seeded = false;
      _onTasksChanged();
    }
  }

  // Detect tasks that newly become assigned to me. The first loaded snapshot is
  // the baseline (no banner); only later transitions notify.
  void _onTasksChanged() {
    final vm = _tasksVm;
    final uid = _uid;
    if (vm == null || uid == null || uid.isEmpty) return;
    // Wait for the first real snapshot so existing assignments aren't announced.
    if (vm.loading) return;

    final mine = {
      for (final t in vm.tasks)
        if (t.assigneeId == uid) t.id,
    };
    if (!_seeded) {
      _assignedToMe = mine;
      _seeded = true;
      return;
    }

    final newly = mine.difference(_assignedToMe);
    _assignedToMe = mine;
    if (newly.isEmpty) return;

    final taskId = newly.first;
    final task = vm.tasks.firstWhere(
      (t) => t.id == taskId,
      orElse: () => Task(id: taskId, title: 'a task', createdBy: ''),
    );
    _showAssignedBanner(task);
  }

  void _showAssignedBanner(Task task) {
    final messenger = ScaffoldMessenger.of(context);
    final nav = context.read<NavigationService>();
    // Defer to after the current frame — the listener can fire mid-build.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      messenger
        ..clearSnackBars()
        ..showSnackBar(
          SnackBar(
            content: Text('New task assigned to you: ${task.title}'),
            action: SnackBarAction(
              label: 'View',
              onPressed: () => nav.goTaskDetails(widget.repoId, task.id),
            ),
          ),
        );
    });
  }

  @override
  void dispose() {
    _tasksVm?.removeListener(_onTasksChanged);
    super.dispose();
  }

  static const _items = <_NavItem>[
    _NavItem(
      icon: Icons.view_kanban_outlined,
      selectedIcon: Icons.view_kanban,
      label: '任務',
      segment: 'tasks',
    ),
    _NavItem(
      icon: Icons.today_outlined,
      selectedIcon: Icons.today,
      label: '每日彙整',
      segment: 'daily',
    ),
    _NavItem(
      icon: Icons.bar_chart_outlined,
      selectedIcon: Icons.bar_chart,
      label: '統計',
      segment: 'stats',
    ),
    _NavItem(
      icon: Icons.settings_outlined,
      selectedIcon: Icons.settings,
      label: '設定',
      segment: 'settings',
    ),
  ];

  int _selectedIndex(BuildContext context) {
    final location = GoRouterState.of(context).uri.path;
    for (var i = 0; i < _items.length; i++) {
      if (location.contains('/${_items[i].segment}')) return i;
    }
    return 0;
  }

  @override
  Widget build(BuildContext context) {
    final currentIndex = _selectedIndex(context);
    // Page-swap animation lives at the route level via CustomTransitionPage +
    // sharedAxisSlide (see lib/router/shell_transitions.dart). ShellNavSignal
    // is updated below before navigating so the transition reads the
    // right direction.
    return Scaffold(
      body: widget.child,
      bottomNavigationBar: _SlidingBottomNav(
        key: RepoShell._navKey,
        selectedIndex: currentIndex,
        items: _items,
        onTap: (i) {
          ShellNavSignal.goingRight = i >= ShellNavSignal.previousIndex;
          ShellNavSignal.previousIndex = i;
          context.go('/repos/${widget.repoId}/${_items[i].segment}');
        },
      ),
    );
  }
}

class _SlidingBottomNav extends StatefulWidget {
  const _SlidingBottomNav({
    super.key,
    required this.selectedIndex,
    required this.items,
    required this.onTap,
  });

  final int selectedIndex;
  final List<_NavItem> items;
  final ValueChanged<int> onTap;

  @override
  State<_SlidingBottomNav> createState() => _SlidingBottomNavState();
}

class _SlidingBottomNavState extends State<_SlidingBottomNav>
    with SingleTickerProviderStateMixin {
  static const _height = 80.0;
  static const _pillHeight = 56.0;
  static const _pillWidth = 64.0;
  // Indicator pill timing. AppMotion.nav matches the content swap so the pill
  // and page slide settle together. Keep Curves.easeOut (below) — the pill's
  // ease was deliberately tuned for the indicator, swapping to emphasized
  // changes how it reads.
  static const _duration = AppMotion.nav;

  late final AnimationController _controller;
  late int _activeIndex;
  late double _from;
  late double _to;

  double _fraction(int index) {
    final n = widget.items.length;
    return n <= 1 ? 0.0 : index / (n - 1);
  }

  double get _currentPosition {
    final curved = Curves.easeOut.transform(_controller.value);
    return _from + (_to - _from) * curved;
  }

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: _duration);
    _activeIndex = widget.selectedIndex;
    _from = _fraction(_activeIndex);
    _to = _from;
  }

  @override
  void didUpdateWidget(covariant _SlidingBottomNav oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Sync if external navigation changed the index (e.g. deep link)
    // but only if we aren't already animating to it.
    if (widget.selectedIndex != _activeIndex && !_controller.isAnimating) {
      _activeIndex = widget.selectedIndex;
      _from = _fraction(_activeIndex);
      _to = _from;
    }
  }

  void _handleTap(int index) {
    if (index == _activeIndex) return;
    // Start animation IMMEDIATELY on tap — before GoRouter rebuilds.
    setState(() {
      _from = _currentPosition;
      _activeIndex = index;
      _to = _fraction(index);
      _controller.forward(from: 0);
    });
    // Then navigate.
    widget.onTap(index);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final bottomPadding = MediaQuery.of(context).padding.bottom;
    return Container(
      height: _height + bottomPadding,
      decoration: BoxDecoration(
        color: Theme.of(context).brightness == Brightness.dark
            ? const Color(0xFF222630)
            : const Color(0xFFFFFFFF),
        boxShadow: [
          BoxShadow(
            color: scheme.shadow.withValues(alpha: 0.08),
            blurRadius: 4,
            offset: const Offset(0, -1),
          ),
        ],
      ),
      padding: EdgeInsets.only(bottom: bottomPadding),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final totalWidth = constraints.maxWidth;
          final tabWidth = totalWidth / widget.items.length;

          return AnimatedBuilder(
            animation: _controller,
            builder: (context, _) {
              final pos = _currentPosition;
              final pillLeft =
                  pos * (totalWidth - tabWidth) + (tabWidth - _pillWidth) / 2;

              return Stack(
                children: [
                  // Sliding pill
                  Positioned(
                    left: pillLeft,
                    top: (_height - _pillHeight) / 2,
                    child: Container(
                      width: _pillWidth,
                      height: _pillHeight,
                      decoration: BoxDecoration(
                        color: scheme.primaryContainer,
                        borderRadius: BorderRadius.circular(_pillHeight / 2),
                      ),
                    ),
                  ),
                  // Tab buttons — use _activeIndex for visual state
                  Row(
                    children: [
                      for (var i = 0; i < widget.items.length; i++)
                        Expanded(
                          child: GestureDetector(
                            behavior: HitTestBehavior.opaque,
                            onTap: () => _handleTap(i),
                            child: SizedBox(
                              height: _height,
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Icon(
                                    i == _activeIndex
                                        ? widget.items[i].selectedIcon
                                        : widget.items[i].icon,
                                    size: 24,
                                    color: i == _activeIndex
                                        ? scheme.onPrimaryContainer
                                        : scheme.onSurfaceVariant,
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    widget.items[i].label,
                                    style: TextStyle(
                                      fontSize: 12,
                                      fontWeight: i == _activeIndex
                                          ? FontWeight.w600
                                          : null,
                                      color: i == _activeIndex
                                          ? scheme.onPrimaryContainer
                                          : scheme.onSurfaceVariant,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ],
              );
            },
          );
        },
      ),
    );
  }
}

class _NavItem {
  const _NavItem({
    required this.icon,
    required this.selectedIcon,
    required this.label,
    required this.segment,
  });
  final IconData icon;
  final IconData selectedIcon;
  final String label;
  final String segment;
}
