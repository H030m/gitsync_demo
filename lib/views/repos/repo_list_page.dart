import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_strings.dart';
import '../../models/repo.dart';
import '../../services/authentication.dart';
import '../../services/navigation.dart';
import '../../theme/app_dimens.dart';
import '../../view_models/repo_list_vm.dart';
import '../../widgets/empty_state.dart';

// RepoListPage — lists every repo the signed-in user is a member of.
// TODO: implement final UI per prototype `RepoList.tsx`.
class RepoListPage extends StatelessWidget {
  const RepoListPage({super.key});

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    final auth = Provider.of<AuthenticationService>(context, listen: false);
    final uid = auth.currentUid;
    if (uid == null) {
      // ShellRoute is supposed to keep us off this page when signed out;
      // fall through to a sign-in prompt just in case.
      return Scaffold(
        body: Center(child: Text(s.notSignedIn)),
      );
    }

    return ChangeNotifierProvider(
      create: (_) => RepoListViewModel(userId: uid),
      child: Scaffold(
        appBar: AppBar(
          title: Text(s.yourRepos),
          automaticallyImplyLeading: false,
        ),
        floatingActionButton: FloatingActionButton(
          onPressed: () => Provider.of<NavigationService>(context, listen: false)
              .goAddRepo(),
          child: const Icon(Icons.add),
        ),
        body: Consumer<RepoListViewModel>(
          builder: (ctx, vm, _) {
            if (vm.loading) {
              return const Center(child: CircularProgressIndicator());
            }
            if (vm.repos.isEmpty) {
              return EmptyState(
                icon: Icons.folder_open_outlined,
                title: s.noReposTitle,
                message: s.noReposMsg,
              );
            }
            final theme = Theme.of(ctx);
            final scheme = theme.colorScheme;
            return ListView.builder(
              padding: const EdgeInsets.symmetric(
                horizontal: AppDimens.spacingMd + 4,
                vertical: AppDimens.spacingMd,
              ),
              itemCount: vm.repos.length + 1, // +1 for add card
              itemBuilder: (_, i) {
                // Add card at the end
                if (i == vm.repos.length) {
                  return Padding(
                    padding: const EdgeInsets.only(top: AppDimens.spacingSm),
                    child: GestureDetector(
                      onTap: () =>
                          Provider.of<NavigationService>(ctx, listen: false)
                              .goAddRepo(),
                      child: Container(
                        padding: const EdgeInsets.all(AppDimens.spacingMd),
                        decoration: BoxDecoration(
                          color: theme.brightness == Brightness.light
                              ? const Color(0xFFFFFFFF)
                              : scheme.surfaceContainerHigh,
                          borderRadius:
                              BorderRadius.circular(AppDimens.radiusLg),
                          border: Border.all(
                            color: scheme.primary.withValues(alpha: 0.4),
                          ),
                          boxShadow: [
                            BoxShadow(
                              color: scheme.shadow.withValues(alpha: 0.06),
                              blurRadius: 6,
                              offset: const Offset(0, 2),
                            ),
                          ],
                        ),
                        child: Row(
                          children: [
                            Container(
                              width: 48,
                              height: 48,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                border: Border.all(
                                  color:
                                      scheme.primary.withValues(alpha: 0.4),
                                ),
                              ),
                              child: Icon(Icons.add,
                                  size: 20,
                                  color:
                                      scheme.primary.withValues(alpha: 0.6)),
                            ),
                            const SizedBox(width: AppDimens.spacingMd),
                            Text(
                              '新增 Repo...',
                              style: TextStyle(
                                fontSize: 14,
                                color:
                                    scheme.primary.withValues(alpha: 0.6),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  );
                }

                final repo = vm.repos[i];
                final removing = vm.isRemoving(repo.id);
                final isEdge = i == 0 || i == vm.repos.length - 1;
                return Padding(
                  padding: const EdgeInsets.only(bottom: AppDimens.spacingSm),
                  child: GestureDetector(
                    onTap: removing
                        ? null
                        : () =>
                            Provider.of<NavigationService>(ctx, listen: false)
                                .goTasks(repo.id),
                    onLongPress: removing
                        ? null
                        : () => _confirmRemove(ctx, vm, repo),
                    child: Container(
                      padding: const EdgeInsets.all(AppDimens.spacingMd),
                      decoration: BoxDecoration(
                        color: theme.brightness == Brightness.light
                            ? const Color(0xFFFFFFFF)
                            : scheme.surfaceContainerHigh,
                        borderRadius:
                            BorderRadius.circular(AppDimens.radiusLg),
                        border: Border.all(
                          color: scheme.outlineVariant.withValues(alpha: 0.4),
                        ),
                        boxShadow: [
                          BoxShadow(
                            color: scheme.shadow.withValues(alpha: 0.06),
                            blurRadius: 6,
                            offset: const Offset(0, 2),
                          ),
                        ],
                      ),
                      child: Row(
                        children: [
                          // Tonal avatar
                          Container(
                            width: 48,
                            height: 48,
                            decoration: BoxDecoration(
                              color: scheme.surfaceContainerHighest,
                              shape: BoxShape.circle,
                            ),
                            child: Icon(
                              Icons.fork_right,
                              size: 20,
                              color: scheme.primary,
                            ),
                          ),
                          const SizedBox(width: AppDimens.spacingMd),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  repo.name,
                                  style: const TextStyle(
                                    fontSize: 14,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                                const SizedBox(height: 6),
                                // Shimmer placeholder bar
                                Container(
                                  height: 8,
                                  width: 80,
                                  decoration: BoxDecoration(
                                    color: scheme.surfaceContainerHighest,
                                    borderRadius: BorderRadius.circular(4),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          if (removing)
                            const SizedBox(
                              width: 24,
                              height: 24,
                              child:
                                  CircularProgressIndicator(strokeWidth: 2),
                            )
                          else if (isEdge)
                            Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                color: scheme.primary,
                                shape: BoxShape.circle,
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                );
              },
            );
          },
        ),
      ),
    );
  }

  Future<void> _confirmRemove(
    BuildContext context,
    RepoListViewModel vm,
    Repo repo,
  ) async {
    final s = context.l10n;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        title: Text(s.removeRepoTitle),
        content: Text(s.removeRepoBody(repo.name)),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogCtx).pop(false),
            child: Text(s.cancel),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogCtx).pop(true),
            child: Text(
              s.remove,
              style: TextStyle(
                color: Theme.of(dialogCtx).colorScheme.error,
              ),
            ),
          ),
        ],
      ),
    );

    if (confirmed != true) return;
    if (!context.mounted) return;

    final ok = await vm.removeRepo(repo.id);
    if (ok) return;
    if (!context.mounted) return;

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(vm.lastError ?? s.removeRepoFailed),
        backgroundColor: Theme.of(context).colorScheme.error,
      ),
    );
  }
}

// [feat] 選擇 repo：輸入 GitHub 網址 → 驗證 → 新增並追蹤該 repo，寫入 repos 清單並可切換當前 repo。
