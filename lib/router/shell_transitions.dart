import 'package:flutter/material.dart';

import '../theme/app_motion.dart';

/// Module-level direction signal used by [sharedAxisSlide] so the
/// shell-tab CustomTransitionPages know which way the user is moving.
///
/// Mutated by `RepoShell` immediately before `context.go(...)` on a
/// bottom-nav tap; read by [sharedAxisSlide] inside `transitionsBuilder`
/// every frame so the OUTGOING and INCOMING pages of the same navigation
/// event agree on direction. Capturing the value at `pageBuilder` time
/// would mis-direct the outgoing page on direction-reversing taps
/// (e.g. settings → tasks) because the outgoing page's pageBuilder was
/// called during a previous navigation.
///
/// Two integers and one bool, read/written only on the main isolate
/// during navigation — a deliberate departure from the project's
/// ChangeNotifier-based state-management convention. A RouteObserver or
/// a provider-plumbed Notifier would be meaningfully more code for the
/// same outcome.
class ShellNavSignal {
  ShellNavSignal._();

  /// Index of the last shell tab the user routed to. Updated by
  /// `RepoShell._onTap` before navigating.
  static int previousIndex = 0;

  /// True if the latest navigation moved forward through the tab list
  /// (i.e. new index >= previousIndex). Used to pick slide direction.
  static bool goingRight = true;
}

/// Shared-axis horizontal slide + fade. Single source of truth for the
/// four shell-tab CustomTransitionPages in [appRouter]. Duration is
/// owned by the page (`transitionDuration: AppMotion.nav`); this builder
/// only authors the curves and offsets.
///
/// Direction comes from [ShellNavSignal.goingRight], read inside the
/// builder every frame (not captured) so both the outgoing and incoming
/// pages of the same navigation event agree.
Widget sharedAxisSlide(
  BuildContext ctx,
  Animation<double> animation,
  Animation<double> secondaryAnimation,
  Widget child,
) {
  final goingRight = ShellNavSignal.goingRight;
  final enterOffset = Offset(goingRight ? 0.06 : -0.06, 0);
  final exitOffset = Offset(goingRight ? -0.06 : 0.06, 0);

  final enterSlide = Tween<Offset>(
    begin: enterOffset,
    end: Offset.zero,
  ).animate(CurvedAnimation(
    parent: animation,
    curve: AppMotion.emphasized,
  ));
  final exitSlide = Tween<Offset>(
    begin: Offset.zero,
    end: exitOffset,
  ).animate(CurvedAnimation(
    parent: secondaryAnimation,
    curve: AppMotion.emphasized,
  ));

  return SlideTransition(
    position: enterSlide,
    child: SlideTransition(
      position: exitSlide,
      child: FadeTransition(
        // ReverseAnimation so the outgoing page fades OUT as secondaryAnim grows.
        opacity: ReverseAnimation(secondaryAnimation),
        child: FadeTransition(
          opacity: animation,
          child: child,
        ),
      ),
    ),
  );
}
