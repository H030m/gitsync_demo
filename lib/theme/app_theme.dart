import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'app_dimens.dart';

// App themes. Light is seeded from the brand blue; dark from the warm accent.
// Component sub-themes are centralized in [_themeFrom] so polish (rounded cards,
// flat app bars, pill buttons, etc.) applies app-wide from one place.
final ThemeData lightTheme = _themeFrom(
  ColorScheme.fromSeed(
    brightness: Brightness.light,
    seedColor: const Color(0xFF1565C0),
    surface: const Color(0xFFEEF5FF),
  ),
  GoogleFonts.notoSansTcTextTheme(),
);

final ThemeData darkTheme = _themeFrom(
  ColorScheme.fromSeed(
    brightness: Brightness.dark,
    seedColor: const Color(0xFFFAB28E),
    surface: const Color(0xFF1C1E26),
  ),
  GoogleFonts.notoSansTcTextTheme(
    ThemeData(brightness: Brightness.dark).textTheme,
  ),
);

ThemeData _themeFrom(ColorScheme scheme, TextTheme textTheme) {
  final isDark = scheme.brightness == Brightness.dark;
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    textTheme: textTheme,
    scaffoldBackgroundColor: scheme.surface,
    appBarTheme: AppBarTheme(
      centerTitle: true,
      elevation: 0,
      scrolledUnderElevation: 2,
      backgroundColor: scheme.surface,
      foregroundColor: scheme.onSurface,
      surfaceTintColor: Colors.transparent,
      titleTextStyle: textTheme.titleLarge?.copyWith(
        fontWeight: FontWeight.w600,
        color: scheme.onSurface,
      ),
      shape: Border(
        bottom: BorderSide(
          color: scheme.outlineVariant.withValues(alpha: 0.5),
        ),
      ),
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      margin: const EdgeInsets.symmetric(
        horizontal: AppDimens.spacingMd,
        vertical: AppDimens.spacingXs + 2,
      ),
      clipBehavior: Clip.antiAlias,
      color: isDark ? scheme.surfaceContainerHigh : scheme.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppDimens.radiusMd),
        side: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.5)),
      ),
    ),
    listTileTheme: ListTileThemeData(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppDimens.radiusSm),
      ),
      contentPadding: const EdgeInsets.symmetric(
        horizontal: AppDimens.spacingMd,
        vertical: AppDimens.spacingXs,
      ),
    ),
    dividerTheme: DividerThemeData(
      space: 1,
      thickness: 1,
      color: scheme.outlineVariant.withValues(alpha: 0.6),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        padding: const EdgeInsets.symmetric(
          horizontal: AppDimens.spacingLg,
          vertical: AppDimens.spacingSm + AppDimens.spacingXs,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppDimens.radiusMd),
        ),
        textStyle: textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w600),
      ),
    ),
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: SegmentedButton.styleFrom(
        selectedBackgroundColor: scheme.primary,
        selectedForegroundColor: scheme.onPrimary,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppDimens.radiusMd),
        ),
      ),
    ),
    chipTheme: ChipThemeData(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppDimens.radiusLg),
      ),
      side: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.6)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: scheme.surfaceContainerHighest.withValues(alpha: 0.5),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppDimens.radiusMd),
        borderSide: BorderSide(color: scheme.outlineVariant),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppDimens.radiusMd),
        borderSide: BorderSide(color: scheme.outlineVariant),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppDimens.radiusMd),
        borderSide: BorderSide(color: scheme.primary, width: 2),
      ),
    ),
    floatingActionButtonTheme: FloatingActionButtonThemeData(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppDimens.radiusLg),
      ),
    ),
    tabBarTheme: TabBarThemeData(
      indicatorColor: scheme.primary,
      labelColor: scheme.primary,
      unselectedLabelColor: scheme.onSurfaceVariant,
      dividerColor: scheme.outlineVariant.withValues(alpha: 0.5),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppDimens.radiusSm),
      ),
    ),
  );
}
