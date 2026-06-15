/// Links a [AppUser] to an [Event] they signed up for.
class Registration {
  const Registration({
    required this.userId,
    required this.eventId,
    required this.createdAt,
  });

  final String userId;
  final String eventId;
  final DateTime createdAt;
}
