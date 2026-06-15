import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import '../config/app_config.dart';
import '../repositories/user_repo.dart';
import 'local_notifications.dart';
import 'navigation.dart';

// FCM wiring. Three responsibilities:
//   1. Pull the FCM token and persist it to `users/{uid}.fcmToken`.
//   2. Handle foreground notifications (logged; the in-app assignment banner in
//      RepoShell covers the foreground "you were assigned" UX via Firestore).
//   3. Route taps on notifications to the matching task via the data payload
//      ({ type, repoId, taskId } — see tools/notify.ts), falling back to /notify.
//
// NOTE: must only be initialized in live (Firebase) mode — FirebaseMessaging
// requires an initialized Firebase app, which fake-backend mode skips.
class PushMessagingService {
  PushMessagingService({UserRepository? userRepository})
      : _userRepository = userRepository ?? UserRepository();

  final FirebaseMessaging _fcm = FirebaseMessaging.instance;
  final UserRepository _userRepository;
  NavigationService? _navigation;
  bool _initialized = false;

  Future<bool> initialize({
    required String userId,
    NavigationService? navigation,
  }) async {
    if (_initialized) return true;
    _navigation = navigation;

    final settings = await _fcm.requestPermission();
    if (settings.authorizationStatus != AuthorizationStatus.authorized) {
      // Permission denied — leave uninitialized so a later sign-in can retry.
      return false;
    }
    _initialized = true;

    // Local-notification channel so foreground FCM can surface as a real OS
    // notification (Android otherwise swallows them while the app is open).
    await LocalNotificationsService.instance.init(
      onTap: (_) => _navigation?.goNotify(),
    );

    // Foreground messages: redraw as a visible local notification, in addition
    // to the in-app banner (RepoShell, Firestore listener on assigneeId == me).
    FirebaseMessaging.onMessage.listen((m) {
      debugPrint('[FCM foreground] ${m.notification?.title}');
      final n = m.notification;
      final title = n?.title ?? m.data['title'] ?? 'GitSync';
      final body = n?.body ?? m.data['body'] ?? '';
      LocalNotificationsService.instance.show(
        title: title,
        body: body,
        payload: m.data['taskId'],
      );
    });

    // Tap while the app was backgrounded.
    FirebaseMessaging.onMessageOpenedApp.listen(_handleTap);

    // Background messages need a top-level handler (see bottom of file).
    FirebaseMessaging.onBackgroundMessage(_backgroundHandler);

    // Cold start: the app was launched by tapping a notification.
    final initial = await _fcm.getInitialMessage();
    if (initial != null) _handleTap(initial);

    String? token;
    if (kIsWeb) {
      final vapidKey = AppConfig.fcmVapidKey;
      if (vapidKey.isEmpty) {
        debugPrint(
          '[FCM web] FCM_VAPID_KEY not set — token fetch skipped. '
          'See docs/SETUP.md (or README) for how to obtain one.',
        );
      } else {
        token = await _fcm.getToken(vapidKey: vapidKey);
      }
    } else {
      token = await _fcm.getToken();
    }
    if (token != null) {
      await _userRepository.updateFcmToken(userId, token);
    }
    _fcm.onTokenRefresh.listen((t) {
      _userRepository.updateFcmToken(userId, t);
    });
    return true;
  }

  // Deep-link a tapped notification to its task when the data payload carries
  // repoId + taskId; otherwise land on the generic /notify screen.
  void _handleTap(RemoteMessage m) {
    final nav = _navigation;
    if (nav == null) return;
    final repoId = m.data['repoId'];
    final taskId = m.data['taskId'];
    if (repoId != null &&
        repoId.isNotEmpty &&
        taskId != null &&
        taskId.isNotEmpty) {
      nav.goTaskDetails(repoId, taskId);
    } else {
      nav.goNotify();
    }
  }
}

@pragma('vm:entry-point')
Future<void> _backgroundHandler(RemoteMessage message) async {
  // Background messages only log here; FCM already shows the system tray
  // notification.
  debugPrint('[FCM background] ${message.messageId}');
}
