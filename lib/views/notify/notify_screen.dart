import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_strings.dart';
import '../../services/navigation.dart';

// NotifyScreen — landing page when the user taps an FCM notification.
// TODO: parse the payload and forward to the matching task / daily route.
class NotifyScreen extends StatelessWidget {
  const NotifyScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(s.notificationTitle)),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.notifications, size: 64),
            const SizedBox(height: 16),
            Text(s.openedFromPush),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: () =>
                  Provider.of<NavigationService>(context, listen: false)
                      .goRepos(),
              child: Text(s.backToRepos),
            ),
          ],
        ),
      ),
    );
  }
}
