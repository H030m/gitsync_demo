import 'package:flutter/material.dart';

import '../theme/app_dimens.dart';

// Shared, centered empty-state placeholder: an outlined icon, a title, and an
// optional one-line hint. Used by list pages so "nothing here yet" looks
// intentional and consistent instead of a bare centered string.
class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.message,
    this.action,
  });

  final IconData icon;
  final String title;
  final String? message;

  /// Optional call-to-action rendered under the message (e.g. a reset-filter
  /// button when a filter produced the empty result).
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppDimens.spacingLg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 56, color: scheme.onSurfaceVariant.withValues(alpha: 0.6)),
            const SizedBox(height: AppDimens.spacingMd),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    color: scheme.onSurface,
                    fontWeight: FontWeight.w600,
                  ),
            ),
            if (message != null) ...[
              const SizedBox(height: AppDimens.spacingXs),
              Text(
                message!,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
              ),
            ],
            if (action != null) ...[
              const SizedBox(height: AppDimens.spacingMd),
              action!,
            ],
          ],
        ),
      ),
    );
  }
}
