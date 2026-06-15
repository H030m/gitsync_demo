import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../config/app_config.dart';
import '../../l10n/app_strings.dart';
import '../../services/locale_notifier.dart';
import '../../services/navigation.dart';
import '../../services/push_messaging.dart';
import '../../theme/app_dimens.dart';
import '../../view_models/auth_vm.dart';

// SignInPage — GitHub OAuth sign-in entry point.
// TODO: implement final UI per prototype `references/GitSync/src/app/pages/SignIn.tsx`.
class SignInPage extends StatelessWidget {
  const SignInPage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Consumer<AuthViewModel>(
          builder: (ctx, vm, _) {
            final s = ctx.l10n;
            final theme = Theme.of(ctx);
            final scheme = theme.colorScheme;
            return ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 360),
              child: Padding(
                padding: const EdgeInsets.all(AppDimens.spacingLg),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 88,
                      height: 88,
                      decoration: BoxDecoration(
                        color: scheme.primaryContainer,
                        borderRadius: BorderRadius.circular(AppDimens.radiusLg),
                      ),
                      child: Icon(
                        Icons.sync_alt,
                        size: 44,
                        color: scheme.onPrimaryContainer,
                      ),
                    ),
                    const SizedBox(height: AppDimens.spacingLg),
                    Text(
                      'GitSync',
                      style: theme.textTheme.displaySmall
                          ?.copyWith(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: AppDimens.spacingSm),
                    Text(
                      s.appTagline,
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodyMedium
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                    const SizedBox(height: AppDimens.spacingLg + AppDimens.spacingSm),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        onPressed: vm.isSigningIn
                            ? null
                            : () async {
                                final ok = await vm.signInWithGitHub();
                                if (!ctx.mounted) return;
                                if (ok) {
                                  final nav = Provider.of<NavigationService>(
                                      ctx,
                                      listen: false);
                                  // Register for push: pull the FCM token and
                                  // wire tap-routing. Live mode only — fake
                                  // mode has no Firebase app. Fire-and-forget so
                                  // the permission prompt doesn't block nav.
                                  final uid = vm.currentUid;
                                  if (uid != null) {
                                    // Mirror the chosen UI language to the user
                                    // doc so backend push copy is localized.
                                    Provider.of<LocaleNotifier>(ctx,
                                            listen: false)
                                        .attachUser(uid);
                                  }
                                  if (!AppConfig.useFakeBackend && uid != null) {
                                    Provider.of<PushMessagingService>(ctx,
                                            listen: false)
                                        .initialize(
                                            userId: uid, navigation: nav);
                                  }
                                  nav.goRepos();
                                }
                              },
                        icon: vm.isSigningIn
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Icon(Icons.code),
                        label: Text(vm.isSigningIn
                            ? s.signingIn
                            : s.signInWithGitHub),
                      ),
                    ),
                    if (vm.lastError != null) ...[
                      const SizedBox(height: AppDimens.spacingMd),
                      Text(
                        vm.lastError!,
                        textAlign: TextAlign.center,
                        style: TextStyle(color: scheme.error),
                      ),
                    ],
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}
