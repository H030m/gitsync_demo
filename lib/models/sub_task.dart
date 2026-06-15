// Shape of a single subtask returned by `breakdownTaskFlow` to Flutter.
// The backend has already translated `dependsOn` from `number[]` (LLM
// 0-based indices) to `string[]` real taskIds. See MEMORY.md
// 2026-05-26 "dependsOn type contract".
class SubTask {
  final String id;
  final String title;
  final String description;
  final List<String> dependsOn;
  final double estimatedHours;

  const SubTask({
    required this.id,
    required this.title,
    required this.description,
    required this.dependsOn,
    required this.estimatedHours,
  });

  factory SubTask.fromMap(Map<String, dynamic> map) {
    return SubTask(
      id: map['id'] as String? ?? '',
      title: map['title'] as String? ?? '',
      description: map['description'] as String? ?? '',
      dependsOn: List<String>.from(map['dependsOn'] as List? ?? []),
      estimatedHours: (map['estimatedHours'] as num?)?.toDouble() ?? 0.0,
    );
  }

  Map<String, dynamic> toMap() => {
        'id': id,
        'title': title,
        'description': description,
        'dependsOn': dependsOn,
        'estimatedHours': estimatedHours,
      };
}
