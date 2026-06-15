import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../config/app_config.dart';
import '../../l10n/app_locale.dart';
import '../../l10n/app_strings.dart';
import '../../services/authentication.dart';
import '../../services/functions_service.dart';
import '../../services/local_notifications.dart';
import '../../services/locale_notifier.dart';
import '../../services/navigation.dart';
import '../../services/theme_mode_notifier.dart';
import '../../theme/app_dimens.dart';

// SettingsPage — language + theme selectors, backend-mode indicator, sign-out.
class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key, required this.repoId});
  final String repoId;

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(s.settingsTitle)),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: AppDimens.spacingSm),
        children: [
          const _BackendBanner(),
          _SectionLabel(s.language),
          const _LanguageSelector(),
          const SizedBox(height: AppDimens.spacingSm),
          _SectionLabel(s.appearance),
          const _ThemeSelector(),
          const SizedBox(height: AppDimens.spacingSm),
          _SectionLabel(s.notifications),
          ListTile(
            leading: const Icon(Icons.notifications_active_outlined),
            title: Text(s.sendTestNotification),
            onTap: () async {
              final messenger = ScaffoldMessenger.of(context);
              try {
                final permitted =
                    await LocalNotificationsService.instance.ensurePermission();
                if (!permitted) {
                  // Permission denied at the OS level: show() would silently
                  // no-op, so tell the user where to turn notifications on.
                  messenger.showSnackBar(
                    SnackBar(content: Text(s.notificationsDisabledHint)),
                  );
                  return;
                }
                await LocalNotificationsService.instance.show(
                  title: s.testNotificationTitle,
                  body: s.testNotificationBody,
                );
              } catch (e) {
                // Most likely the app was hot-restarted without a full rebuild,
                // so the native plugin isn't in the running APK.
                messenger.showSnackBar(
                  SnackBar(content: Text('${s.notificationFailed}: $e')),
                );
              }
            },
          ),
          const SizedBox(height: AppDimens.spacingSm),
          _SectionLabel(s.dangerZone),
          ListTile(
            leading: Icon(Icons.delete_sweep_outlined,
                color: Theme.of(context).colorScheme.error),
            title: Text(s.deleteAllTasks),
            subtitle: Text(s.deleteAllTasksSubtitle),
            textColor: Theme.of(context).colorScheme.error,
            iconColor: Theme.of(context).colorScheme.error,
            onTap: () => _confirmDeleteAllTasks(context),
          ),
          const SizedBox(height: AppDimens.spacingSm),
          _SectionLabel(s.account),
          ListTile(
            title: Text(s.signOut),
            leading:
                Icon(Icons.logout, color: Theme.of(context).colorScheme.error),
            textColor: Theme.of(context).colorScheme.error,
            iconColor: Theme.of(context).colorScheme.error,
            onTap: () async {
              final nav = Provider.of<NavigationService>(context, listen: false);
              Provider.of<LocaleNotifier>(context, listen: false).detachUser();
              await Provider.of<AuthenticationService>(context, listen: false)
                  .logOut();
              nav.goSignIn();
            },
          ),
        ],
      ),
    );
  }

  // Confirm, then delete every task in this repo (demo reset). Captures the
  // messenger/service before awaiting and guards on context.mounted after.
  Future<void> _confirmDeleteAllTasks(BuildContext context) async {
    final s = context.l10n;
    final messenger = ScaffoldMessenger.of(context);
    final functions = Provider.of<FunctionsService>(context, listen: false);

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.deleteAllTasksConfirmTitle),
        content: Text(s.deleteAllTasksConfirmBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(s.cancel),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(ctx).colorScheme.error,
            ),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(s.delete),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    try {
      final n = await functions.deleteAllTasks(repoId: repoId);
      messenger.showSnackBar(SnackBar(content: Text(s.deleteAllTasksDone(n))));
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text('${s.deleteAllTasksFailed}: $e')),
      );
    }
  }
}

// Small uppercase section header used to group settings rows.
class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppDimens.spacingMd,
        AppDimens.spacingMd,
        AppDimens.spacingMd,
        AppDimens.spacingSm,
      ),
      child: Text(
        text.toUpperCase(),
        style: Theme.of(context).textTheme.labelMedium?.copyWith(
              color: scheme.primary,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.8,
            ),
      ),
    );
  }
}

// 中文 / English language switch (persisted via LocaleNotifier).
class _LanguageSelector extends StatelessWidget {
  const _LanguageSelector();

  @override
  Widget build(BuildContext context) {
    final notifier = context.watch<LocaleNotifier>();
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppDimens.spacingMd),
      child: SegmentedButton<AppLocale>(
        segments: const [
          ButtonSegment(value: AppLocale.zhHant, label: Text('中文（繁體）')),
          ButtonSegment(value: AppLocale.en, label: Text('English')),
        ],
        selected: {notifier.locale},
        showSelectedIcon: false,
        onSelectionChanged: (sel) => notifier.setLocale(sel.first),
      ),
    );
  }
}

// Three-way System / Light / Dark selector.
class _ThemeSelector extends StatelessWidget {
  const _ThemeSelector();

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final theme = context.watch<ThemeModeNotifier>();
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppDimens.spacingMd),
      child: SegmentedButton<ThemeMode>(
        segments: [
          ButtonSegment(
            value: ThemeMode.system,
            icon: const Icon(Icons.brightness_auto_outlined),
            label: Text(s.themeSystem),
          ),
          ButtonSegment(
            value: ThemeMode.light,
            icon: const Icon(Icons.light_mode_outlined),
            label: Text(s.themeLight),
          ),
          ButtonSegment(
            value: ThemeMode.dark,
            icon: const Icon(Icons.dark_mode_outlined),
            label: Text(s.themeDark),
          ),
        ],
        selected: {theme.mode},
        showSelectedIcon: false,
        onSelectionChanged: (sel) => theme.setMode(sel.first),
      ),
    );
  }
}

class _BackendBanner extends StatelessWidget {
  const _BackendBanner();

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final isFake = AppConfig.useFakeBackend;
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(
        AppDimens.spacingMd,
        AppDimens.spacingSm,
        AppDimens.spacingMd,
        0,
      ),
      padding: const EdgeInsets.all(AppDimens.spacingMd),
      decoration: BoxDecoration(
        color: isFake ? scheme.tertiaryContainer : scheme.primaryContainer,
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
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                isFake ? Icons.bug_report : Icons.cloud_done,
                color: isFake
                    ? scheme.onTertiaryContainer
                    : scheme.onPrimaryContainer,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  isFake ? s.backendFakeTitle : s.backendLiveTitle,
                  style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        color: isFake
                            ? scheme.onTertiaryContainer
                            : scheme.onPrimaryContainer,
                        fontWeight: FontWeight.bold,
                      ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            isFake ? s.backendFakeBody : s.backendLiveBody,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: isFake
                      ? scheme.onTertiaryContainer
                      : scheme.onPrimaryContainer,
                ),
          ),
        ],
      ),
    );
  }
}
