import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:provider/provider.dart';

import 'config/app_config.dart';
import 'firebase_options.dart';
import 'l10n/app_locale.dart';
import 'services/authentication.dart';
import 'services/functions_service.dart';
import 'services/locale_notifier.dart';
import 'services/navigation.dart';
import 'services/push_messaging.dart';
import 'services/theme_mode_notifier.dart';
import 'theme/app_theme.dart';
import 'view_models/auth_vm.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Fake-backend mode skips Firebase entirely so the app boots on a fresh
  // clone with no `flutterfire configure` run yet.
  if (!AppConfig.useFakeBackend) {
    await Firebase.initializeApp(
      options: DefaultFirebaseOptions.currentPlatform,
    );
    if (AppConfig.useEmulator) {
      _useEmulators();
    }
  } else {
    debugPrint(
      '[GitSync] Running in FAKE backend mode '
      '(AppConfig.backend = ${AppConfig.backend.name}). '
      'No Firebase / OpenAI / GitHub calls will be made.',
    );
  }
  runApp(const GitSyncApp());
}

// Routes Firestore / Auth / Functions to the local Firebase Emulator Suite.
// Ports match firebase.json (firestore 8080, auth 9099, functions 5001). The
// Functions instance must be the same region [FunctionsService] talks to
// (asia-east1), or the override won't apply to the app's callables.
void _useEmulators() {
  final host = AppConfig.emulatorHost;
  FirebaseFirestore.instance.useFirestoreEmulator(host, 8080);
  FirebaseAuth.instance.useAuthEmulator(host, 9099);
  FirebaseFunctions.instanceFor(region: 'asia-east1')
      .useFunctionsEmulator(host, 5001);
  debugPrint(
    '[GitSync] Using Firebase emulators at $host '
    '(firestore:8080, auth:9099, functions:5001)',
  );
}

class GitSyncApp extends StatelessWidget {
  const GitSyncApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        // Services (singletons; do not need ChangeNotifier).
        Provider<AuthenticationService>(create: (_) => AuthenticationService()),
        Provider<NavigationService>(create: (_) => NavigationService()),
        Provider<FunctionsService>(create: (_) => FunctionsService()),
        Provider<PushMessagingService>(create: (_) => PushMessagingService()),
        // Global ChangeNotifiers.
        ChangeNotifierProvider<ThemeModeNotifier>(
          create: (_) => ThemeModeNotifier(),
        ),
        ChangeNotifierProvider<LocaleNotifier>(create: (_) => LocaleNotifier()),
        ChangeNotifierProvider<AuthViewModel>(create: (_) => AuthViewModel()),
      ],
      child: Consumer2<ThemeModeNotifier, LocaleNotifier>(
        builder: (ctx, themeMode, localeNotifier, _) {
          final nav = Provider.of<NavigationService>(ctx, listen: false);
          return MaterialApp.router(
            title: 'GitSync',
            theme: lightTheme,
            darkTheme: darkTheme,
            themeMode: themeMode.mode,
            locale: localeNotifier.locale.locale,
            supportedLocales: const [Locale('en'), Locale('zh', 'TW')],
            localizationsDelegates: const [
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            routerConfig: nav.router,
            debugShowCheckedModeBanner: false,
          );
        },
      ),
    );
  }
}
