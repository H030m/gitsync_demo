import 'package:flutter/material.dart';

import '../theme/app_dimens.dart';

/// Shared white-bg card with rounded corners, border and subtle shadow.
///
/// Used across every page that wraps a content section in a card-like container.
/// Light mode: pure white background. Dark mode: [ColorScheme.surfaceContainerHigh].
class SectionCard extends StatelessWidget {
  const SectionCard({
    super.key,
    required this.child,
    this.padding,
    this.margin,
  });

  final Widget child;

  /// Defaults to `EdgeInsets.all(AppDimens.spacingMd)`.
  final EdgeInsetsGeometry? padding;

  /// Defaults to `null` (no outer margin).
  final EdgeInsetsGeometry? margin;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Container(
      margin: margin,
      padding: padding ?? const EdgeInsets.all(AppDimens.spacingMd),
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
      child: child,
    );
  }
}
