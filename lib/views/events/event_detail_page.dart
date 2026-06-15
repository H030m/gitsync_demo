import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../data/mock_store.dart';
import '../../services/auth_service.dart';
import '../../services/registration_service.dart';

/// Shows one event's detail and lets a logged-in user register or cancel.
class EventDetailPage extends StatelessWidget {
  const EventDetailPage({super.key, required this.eventId});

  final String eventId;

  void _toggleRegistration(BuildContext context) {
    final auth = context.read<AuthService>();
    final reg = context.read<RegistrationService>();
    final messenger = ScaffoldMessenger.of(context);

    if (!auth.isLoggedIn) {
      messenger.showSnackBar(const SnackBar(content: Text('請先登入再報名')));
      return;
    }
    final uid = auth.current!.id;
    try {
      if (reg.isRegistered(uid, eventId)) {
        reg.cancel(uid, eventId);
        messenger.showSnackBar(const SnackBar(content: Text('已取消報名')));
      } else {
        reg.register(uid, eventId);
        messenger.showSnackBar(const SnackBar(content: Text('報名成功！')));
      }
    } on StateError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final store = context.read<MockStore>();
    final auth = context.watch<AuthService>();
    final reg = context.watch<RegistrationService>();
    final event = store.findEvent(eventId);

    if (event == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('活動')),
        body: const Center(child: Text('找不到這個活動')),
      );
    }

    final registered =
        auth.isLoggedIn && reg.isRegistered(auth.current!.id, eventId);
    final left = reg.spotsLeft(event);

    return Scaffold(
      appBar: AppBar(title: Text(event.title)),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _row(Icons.place, event.location),
            const SizedBox(height: 8),
            _row(Icons.event, '${event.startAt.year}/${event.startAt.month}/${event.startAt.day}'),
            const SizedBox(height: 8),
            _row(Icons.people, '剩餘名額 $left / ${event.capacity}'),
            const SizedBox(height: 20),
            Text(event.description,
                style: Theme.of(context).textTheme.bodyLarge),
            const Spacer(),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: (!registered && left <= 0)
                    ? null
                    : () => _toggleRegistration(context),
                child: Text(
                  registered ? '取消報名' : (left <= 0 ? '名額已滿' : '報名'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _row(IconData icon, String text) => Row(
        children: [
          Icon(icon, size: 18),
          const SizedBox(width: 8),
          Text(text),
        ],
      );
}
