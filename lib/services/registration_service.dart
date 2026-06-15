import 'package:flutter/foundation.dart';

import '../data/mock_store.dart';
import '../models/event.dart';
import '../models/registration.dart';

/// Register / cancel for an event, and list a user's registrations.
class RegistrationService extends ChangeNotifier {
  RegistrationService(this._store);

  final MockStore _store;

  bool isRegistered(String userId, String eventId) =>
      _store.isRegistered(userId, eventId);

  int spotsLeft(Event event) =>
      event.capacity - _store.registrationCount(event.id);

  /// Sign [userId] up for [eventId]. Throws when the event is full or the user
  /// is already registered.
  void register(String userId, String eventId) {
    if (_store.isRegistered(userId, eventId)) {
      throw StateError('你已經報名過這個活動');
    }
    final event = _store.findEvent(eventId);
    if (event != null && _store.registrationCount(eventId) >= event.capacity) {
      throw StateError('活動名額已滿');
    }
    _store.addRegistration(
      Registration(userId: userId, eventId: eventId, createdAt: DateTime.now()),
    );
    notifyListeners();
  }

  void cancel(String userId, String eventId) {
    _store.removeRegistration(userId, eventId);
    notifyListeners();
  }

  /// The events [userId] is currently registered for.
  List<Event> myEvents(String userId) {
    return _store
        .registrationsOf(userId)
        .map((r) => _store.findEvent(r.eventId))
        .whereType<Event>()
        .toList();
  }
}
