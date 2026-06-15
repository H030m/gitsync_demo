import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../services/auth_service.dart';
import '../../services/registration_service.dart';

/// Shows the events the current user has registered for, with quick cancel.
class MyRegistrationsPage extends StatelessWidget {
  const MyRegistrationsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final reg = context.watch<RegistrationService>();

    if (!auth.isLoggedIn) {
      return Scaffold(
        appBar: AppBar(title: const Text('我的報名')),
        body: Center(
          child: FilledButton(
            onPressed: () => context.push('/login'),
            child: const Text('請先登入'),
          ),
        ),
      );
    }

    final uid = auth.current!.id;
    final events = reg.myEvents(uid);

    return Scaffold(
      appBar: AppBar(title: const Text('我的報名')),
      body: events.isEmpty
          ? const Center(child: Text('你還沒有報名任何活動'))
          : ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: events.length,
              separatorBuilder: (_, __) => const SizedBox(height: 12),
              itemBuilder: (context, i) {
                final e = events[i];
                return Card(
                  child: ListTile(
                    title: Text(e.title),
                    subtitle: Text(e.location),
                    trailing: TextButton(
                      onPressed: () => reg.cancel(uid, e.id),
                      child: const Text('取消'),
                    ),
                    onTap: () => context.push('/events/${e.id}'),
                  ),
                );
              },
            ),
    );
  }
}
