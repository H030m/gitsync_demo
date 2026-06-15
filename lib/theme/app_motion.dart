import 'package:flutter/material.dart';

// Motion design tokens (durations + curves) for the app's transitions, mirroring
// AppDimens style. Names map to obvious use sites so animation work shares a
// single vocabulary instead of scattering inline Durations/Curves across views.
// Scale follows Material 3's "emphasized" timing guidance (task 06-13).
class AppMotion {
  AppMotion._();

  // Durations — Material 3 emphasized scale.
  /// Micro-interaction (icon flip, chevron rotate, single-item stagger step).
  static const Duration short = Duration(milliseconds: 150);

  /// Medium transitions: modal sheets / dialogs, single list-item entrance.
  static const Duration medium = Duration(milliseconds: 250);

  /// Navigation-level transitions (bottom-nav content swap, route pages).
  /// Matches the existing _SlidingBottomNav indicator (300 ms).
  static const Duration nav = Duration(milliseconds: 300);

  /// Larger choreographed motion (hero, big card expand).
  static const Duration long = Duration(milliseconds: 450);

  // Curves.
  /// Default ease used by implicit animators (AnimatedContainer / AnimatedSize).
  static const Curve standard = Curves.easeInOutCubic;

  /// Material 3 emphasized curve — paired with [nav] for shared-axis swaps.
  static const Curve emphasized = Cubic(0.20, 0.00, 0.00, 1.00);

  /// Emphasized acceleration — entering elements about to settle off-screen.
  static const Curve emphasizedAccel = Cubic(0.30, 0.00, 0.80, 0.15);

  /// Emphasized deceleration — incoming elements (sheet/dialog enter, list
  /// item entrance) so they read as "arriving".
  static const Curve emphasizedDecel = Cubic(0.05, 0.70, 0.10, 1.00);

  /// Sheet/dialog enter+exit timing, as an [AnimationStyle] suitable for
  /// `showModalBottomSheet(sheetAnimationStyle: ...)`. Enter uses
  /// [emphasizedDecel] (arriving), exit uses [emphasizedAccel] (leaving).
  /// This avoids hand-rolling an [AnimationController] / a [TickerProvider]
  /// per callsite — Flutter builds + disposes the controller internally.
  static const AnimationStyle sheetStyle = AnimationStyle(
    duration: medium,
    reverseDuration: medium,
    curve: emphasizedDecel,
    reverseCurve: emphasizedAccel,
  );
}
