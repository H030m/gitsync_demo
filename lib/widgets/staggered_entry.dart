import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/app_motion.dart';

// Per-tile entrance animation (task 06-13): fade + 8 px upward translate, with
// a small per-index delay so a list reads as a top-down stagger. Keep the
// wrapper keyed by a stable item id so re-orders don't replay the tween.
//
//   - Tween: 0.0 → 1.0, duration = [AppMotion.medium],
//     curve = [AppMotion.emphasizedDecel].
//   - Stagger: per-item delay = [AppMotion.short] ~/ 4 (~38 ms), capped at
//     index 7 — items 8+ get zero extra delay (just the base tween) so a long
//     list doesn't visibly cascade past the fold.
//   - Removals: nothing (no lifecycle tracking) — removed items just disappear.
class StaggeredEntry extends StatefulWidget {
  const StaggeredEntry({
    super.key,
    required this.index,
    required this.child,
  });

  /// Position in the list (0-based). Used only to compute the entrance delay;
  /// reorders shouldn't change identity (key by item id at the call site).
  final int index;
  final Widget child;

  /// Maximum index that contributes to the stagger delay. Items past this
  /// fall back to a delay of zero so the cascade doesn't run forever.
  static const int _maxStaggerIndex = 7;

  @override
  State<StaggeredEntry> createState() => _StaggeredEntryState();
}

class _StaggeredEntryState extends State<StaggeredEntry> {
  bool _visible = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    final stepMs = AppMotion.short.inMilliseconds ~/ 4;
    final cappedIndex =
        widget.index.clamp(0, StaggeredEntry._maxStaggerIndex);
    final delayMs = stepMs * cappedIndex;
    if (delayMs <= 0) {
      // No delay → start visible on the next frame so the tween still plays
      // (TweenAnimationBuilder ignores a tween whose endpoints match its
      // initial state).
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) setState(() => _visible = true);
      });
    } else {
      _timer = Timer(Duration(milliseconds: delayMs), () {
        if (mounted) setState(() => _visible = true);
      });
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0.0, end: _visible ? 1.0 : 0.0),
      duration: AppMotion.medium,
      curve: AppMotion.emphasizedDecel,
      builder: (context, t, child) => Opacity(
        opacity: t,
        child: Transform.translate(
          offset: Offset(0, 8 * (1 - t)),
          child: child,
        ),
      ),
      child: widget.child,
    );
  }
}
