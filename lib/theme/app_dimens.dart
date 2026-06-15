import 'package:flutter/widgets.dart';

// Design tokens (radius / spacing) per ARCHITECTURE.md §8.2. Centralized here so
// the whole app shares one spacing+radius scale instead of ad-hoc magic numbers.
class AppDimens {
  AppDimens._();

  // Corner radius
  static const double radiusSm = 8;
  static const double radiusMd = 12;
  static const double radiusLg = 16;

  // Spacing
  static const double spacingXs = 4;
  static const double spacingSm = 8;
  static const double spacingMd = 16;
  static const double spacingLg = 24;

  // Common ready-made paddings (avoid re-allocating EdgeInsets everywhere).
  static const EdgeInsets pagePadding = EdgeInsets.all(spacingMd);
  static const EdgeInsets cardPadding = EdgeInsets.symmetric(
    horizontal: spacingMd,
    vertical: spacingSm + spacingXs,
  );
}
