import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../data/mock_store.dart';
import '../../services/registration_service.dart';

/// Lists all campus events; tap one to see its detail.
class EventListPage extends StatelessWidget {
  const EventListPage({super.key});

  @override
  Widget build(BuildContext context) {
    final store = context.read<MockStore>();
    final reg = context.watch<RegistrationService>();
    final events = store.listEvents();

    return Scaffold(
      appBar: AppBar(title: const Text('校園活動')),
      body: ListView.separated(
        padding: const EdgeInsets.all(16),
        itemCount: events.length,
        separatorBuilder: (_, __) => const SizedBox(height: 12),
        itemBuilder: (context, i) {
          final e = events[i];
          final left = reg.spotsLeft(e);
          return Card(
            child: ListTile(
              title: Text(e.title),
              subtitle: Text('${e.location} · 剩餘名額 $left'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => context.push('/events/${e.id}'),
            ),
          );
        },
      ),
    );
  }
}
