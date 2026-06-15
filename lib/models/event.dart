/// A campus event students can browse and sign up for.
class Event {
  const Event({
    required this.id,
    required this.title,
    required this.description,
    required this.location,
    required this.startAt,
    required this.capacity,
  });

  final String id;
  final String title;
  final String description;
  final String location;
  final DateTime startAt;

  /// Maximum number of registrations allowed.
  final int capacity;
}
