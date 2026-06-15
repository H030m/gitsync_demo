import 'package:go_router/go_router.dart';

import '../views/auth/login_page.dart';
import '../views/events/event_detail_page.dart';
import '../views/events/event_list_page.dart';
import '../views/home/home_page.dart';
import '../views/registrations/my_registrations_page.dart';

/// App route table. Kept flat — the home page links out to the rest.
final appRouter = GoRouter(
  initialLocation: '/',
  routes: [
    GoRoute(path: '/', builder: (context, state) => const HomePage()),
    GoRoute(path: '/login', builder: (context, state) => const LoginPage()),
    GoRoute(
      path: '/events',
      builder: (context, state) => const EventListPage(),
    ),
    GoRoute(
      path: '/events/:id',
      builder: (context, state) =>
          EventDetailPage(eventId: state.pathParameters['id']!),
    ),
    GoRoute(
      path: '/my',
      builder: (context, state) => const MyRegistrationsPage(),
    ),
  ],
);
