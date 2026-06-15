import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../services/auth_service.dart';
import '../../theme/app_theme.dart';

/// Landing page: entry points to the app, plus a light/dark toggle.
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = context.watch<ThemeController>();
    final auth = context.watch<AuthService>();

    return Scaffold(
      appBar: AppBar(
        title: const Text('校園活動報名'),
        actions: [
          IconButton(
            tooltip: theme.isDark ? '切換亮色' : '切換深色',
            icon: Icon(theme.isDark ? Icons.light_mode : Icons.dark_mode),
            onPressed: theme.toggle,
          ),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  '歡迎${auth.isLoggedIn ? '回來，${auth.current!.name}' : ''}！',
                  style: Theme.of(context).textTheme.headlineSmall,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                const Text(
                  '瀏覽校園活動、報名你有興趣的場次。',
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 32),
                FilledButton.icon(
                  onPressed: () => context.push('/events'),
                  icon: const Icon(Icons.event),
                  label: const Text('瀏覽活動'),
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: () => context.push('/my'),
                  icon: const Icon(Icons.bookmark),
                  label: const Text('我的報名'),
                ),
                const SizedBox(height: 12),
                if (auth.isLoggedIn)
                  TextButton(
                    onPressed: auth.logout,
                    child: const Text('登出'),
                  )
                else
                  TextButton(
                    onPressed: () => context.push('/login'),
                    child: const Text('登入 / 註冊'),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
