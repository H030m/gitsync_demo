import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

/// Reusable renderer for AI-generated Markdown (Discord digest, and later the
/// daily summary / task handoff docs). Wraps [MarkdownBody] with app-themed
/// styling so any place that currently shows raw Markdown in a [Text] can swap
/// to `MarkdownView(data: ...)` for proper formatting.
class MarkdownView extends StatelessWidget {
  const MarkdownView({super.key, required this.data, this.selectable = false});

  final String data;
  final bool selectable;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return MarkdownBody(
      data: data,
      selectable: selectable,
      styleSheet: MarkdownStyleSheet.fromTheme(theme).copyWith(
        p: theme.textTheme.bodyMedium,
        code: theme.textTheme.bodySmall?.copyWith(
          fontFamily: 'monospace',
          backgroundColor: theme.colorScheme.surfaceContainerHighest,
        ),
      ),
    );
  }
}
