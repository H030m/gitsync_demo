import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'data/mock_store.dart';
import 'router/app_router.dart';
import 'services/auth_service.dart';
import 'services/registration_service.dart';
import 'theme/app_theme.dart';

void main() {
  // In-memory data store seeded with demo events (no Firebase needed to run).
  final store = MockStore.seeded();
  runApp(CampusEventsApp(store: store));
}

class CampusEventsApp extends StatelessWidget {
  const CampusEventsApp({super.key, required this.store});

  final MockStore store;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        Provider<MockStore>.value(value: store),
        ChangeNotifierProvider(create: (_) => ThemeController()),
        ChangeNotifierProvider(create: (_) => AuthService(store)),
        ChangeNotifierProvider(create: (_) => RegistrationService(store)),
      ],
      child: Consumer<ThemeController>(
        builder: (context, theme, _) => MaterialApp.router(
          title: '校園活動報名系統',
          debugShowCheckedModeBanner: false,
          theme: AppTheme.light(),
          darkTheme: AppTheme.dark(),
          themeMode: theme.mode,
          routerConfig: appRouter,
        ),
      ),
    );
  }
}
