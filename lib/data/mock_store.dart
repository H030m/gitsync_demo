import '../models/app_user.dart';
import '../models/event.dart';
import '../models/registration.dart';

/// In-memory data store standing in for the backend API (Firestore + Functions).
///
/// Holds events, registrations, and the user table. Services read/write through
/// this single source of truth so the app runs without any network setup.
class MockStore {
  MockStore({
    required List<Event> events,
    List<AppUser> users = const [],
    List<Registration> registrations = const [],
  })  : _events = events,
        _users = [...users],
        _registrations = [...registrations];

  final List<Event> _events;
  final List<AppUser> _users;
  final List<Registration> _registrations;

  /// Seed a handful of demo events so the list page is never empty.
  factory MockStore.seeded() {
    final now = DateTime.now();
    return MockStore(
      events: [
        Event(
          id: 'e1',
          title: '校園程式設計工作坊',
          description: '從零開始的 Flutter 實作工作坊，自備筆電。',
          location: '資訊大樓 301',
          startAt: now.add(const Duration(days: 3)),
          capacity: 40,
        ),
        Event(
          id: 'e2',
          title: '春季園遊會',
          description: '社團擺攤、美食與表演，全校開放。',
          location: '中央草坪',
          startAt: now.add(const Duration(days: 7)),
          capacity: 500,
        ),
        Event(
          id: 'e3',
          title: '職涯講座：新創與大公司怎麼選',
          description: '邀請學長姐分享求職經驗與 Q&A。',
          location: '國際會議廳',
          startAt: now.add(const Duration(days: 10)),
          capacity: 120,
        ),
      ],
    );
  }

  // ---- Events --------------------------------------------------------------
  List<Event> listEvents() => List.unmodifiable(_events);

  Event? findEvent(String id) {
    for (final e in _events) {
      if (e.id == id) return e;
    }
    return null;
  }

  int registrationCount(String eventId) =>
      _registrations.where((r) => r.eventId == eventId).length;

  // ---- Users ---------------------------------------------------------------
  AppUser? findUserByEmail(String email) {
    for (final u in _users) {
      if (u.email == email) return u;
    }
    return null;
  }

  AppUser addUser(AppUser user) {
    _users.add(user);
    return user;
  }

  // ---- Registrations -------------------------------------------------------
  bool isRegistered(String userId, String eventId) => _registrations
      .any((r) => r.userId == userId && r.eventId == eventId);

  void addRegistration(Registration r) => _registrations.add(r);

  void removeRegistration(String userId, String eventId) =>
      _registrations.removeWhere(
        (r) => r.userId == userId && r.eventId == eventId,
      );

  List<Registration> registrationsOf(String userId) =>
      _registrations.where((r) => r.userId == userId).toList();
}
