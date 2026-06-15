import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// Pops a visible OS notification even while the app is in the foreground —
/// Android suppresses FCM "notification" messages in that state, so we redraw
/// them ourselves. Used by [PushMessagingService] for incoming foreground FCM
/// and by Settings' "send test notification" demo action.
class LocalNotificationsService {
  LocalNotificationsService._();
  static final LocalNotificationsService instance =
      LocalNotificationsService._();

  final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();
  bool _ready = false;

  static const AndroidNotificationChannel _channel = AndroidNotificationChannel(
    'gitsync_default',
    'GitSync',
    description: 'Task assignments, daily reports, and Discord relays.',
    importance: Importance.high,
  );

  /// Idempotent. [onTap] fires with the notification payload when the user taps
  /// a notification we raised while the app was alive.
  Future<void> init({void Function(String? payload)? onTap}) async {
    if (_ready) return;
    const android = AndroidInitializationSettings('@mipmap/ic_launcher');
    const ios = DarwinInitializationSettings();
    await _plugin.initialize(
      const InitializationSettings(android: android, iOS: ios),
      onDidReceiveNotificationResponse: (resp) => onTap?.call(resp.payload),
    );
    final androidImpl = _plugin.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();
    await androidImpl?.createNotificationChannel(_channel);
    // Android 13+ runtime permission; no-op / already-granted is fine.
    await androidImpl?.requestNotificationsPermission();
    _ready = true;
  }

  /// Whether the OS will currently display our notifications. On non-Android
  /// platforms (or when the platform impl is unavailable) assume true.
  Future<bool> areNotificationsEnabled() async {
    final androidImpl = _plugin.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();
    if (androidImpl == null) return true;
    return await androidImpl.areNotificationsEnabled() ?? true;
  }

  /// Re-requests the notification permission on demand. Returns whether
  /// notifications can now be shown (false when the user keeps them denied,
  /// in which case the caller should point at system settings).
  Future<bool> ensurePermission() async {
    if (!_ready) await init();
    final androidImpl = _plugin.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();
    if (androidImpl == null) return true;
    // `?? false` here (vs `?? true` in [areNotificationsEnabled]): when the
    // state is unknown, prefer re-prompting over silently skipping.
    if (await androidImpl.areNotificationsEnabled() ?? false) return true;
    await androidImpl.requestNotificationsPermission();
    return areNotificationsEnabled();
  }

  Future<void> show({
    required String title,
    required String body,
    String? payload,
  }) async {
    if (!_ready) await init();
    final details = NotificationDetails(
      android: AndroidNotificationDetails(
        _channel.id,
        _channel.name,
        channelDescription: _channel.description,
        importance: Importance.high,
        priority: Priority.high,
        icon: '@mipmap/ic_launcher',
      ),
      iOS: const DarwinNotificationDetails(),
    );
    // Per-call id so successive notifications stack instead of replacing.
    final id = DateTime.now().millisecondsSinceEpoch.remainder(1 << 31);
    await _plugin.show(id, title, body, details, payload: payload);
  }
}
