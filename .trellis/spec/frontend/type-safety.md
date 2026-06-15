# Type Safety (Dart)

> Dart sound null-safety. No codegen (`freezed`/`json_serializable`) — types are hand-written.
> Source: [`COURSE_METHODS.md §4`](../../../docs/COURSE_METHODS.md).

---

## Null-safety conventions

- Prefer non-nullable fields; make a field `?` only when Firestore genuinely may omit it
  (`assigneeId`, `handoffDoc`, `parentTaskId`).
- For server-written timestamps, store a nullable backing field and expose a non-null getter
  with a fallback (`Timestamp get createdAt => _createdAt ?? Timestamp.now();`).
- Defensive parsing in `fromMap`: cast-with-fallback rather than force-unwrap on untrusted
  Firestore data — `map['title'] as String? ?? ''`, `(map['githubIssueNumber'] as num?)?.toInt()`,
  `List<String>.from(map['dependsOn'] as List? ?? [])`.

---

## Enums over magic strings

Model a closed set as an `enum` + extension that maps to/from the Firestore wire value. The wire
string ↔ enum boundary lives entirely in the extension (`.wire` / `fromWire`), so the rest of the
app is string-free. See `lib/models/task.dart` (`TaskStatus`, `TaskSource`).

`fromWire` always has a default branch (`_ => TaskStatus.todo`) so unknown/legacy values don't throw.

---

## The `dependsOn` type contract (don't get this wrong)

- In Flutter/Firestore, `dependsOn` is `List<String>` (real taskIds).
- On the LLM/backend side it's `number[]` (0-based indices); the backend translates indices →
  taskIds before writing. The Flutter side **only ever sees taskIds**. See
  [`ARCHITECTURE.md §5.1`](../../../docs/ARCHITECTURE.md) and `MEMORY.md 2026-05-26`.

---

## Forbidden / discouraged

- `dynamic` flowing through the app — confine `Map<String, dynamic>` to `fromMap`/`toMap`.
- Force-unwrap (`!`) on Firestore data without a null check.
- Raw status/source strings outside the model extensions.

---

## Lint

`analysis_options.yaml` is the source of truth (`flutter analyze` must be 0 error / 0 warning;
the one known info-level `use_null_aware_elements` is expected — see `docs/SETUP.md §2.3`).
