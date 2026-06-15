import 'package:cloud_firestore/cloud_firestore.dart';

import '../config/app_config.dart';
import '../models/daily_report.dart';
import 'fake/fake_daily_report_repo.dart';
import 'firestore_paths.dart';

abstract class DailyReportRepository {
  factory DailyReportRepository() => AppConfig.useFakeBackend
      ? FakeDailyReportRepository()
      : _LiveDailyReportRepository();

  Stream<DailyReport?> streamReport(String repoId, String date);
  Future<DailyReport?> getReport(String repoId, String date);

  /// Streams the per-day reports whose `date` (YYYY-MM-DD) falls inside
  /// [startDate]..[endDate] inclusive. Composite range docs (id like
  /// `{start}_{end}`, written by the multi-day summary) are dropped client-side
  /// so callers only ever see one doc per calendar day.
  Stream<List<DailyReport>> streamReportsInRange(
    String repoId,
    String startDate,
    String endDate,
  );
}

// NOTE: `dailyReports` is write-blocked for clients.
class _LiveDailyReportRepository implements DailyReportRepository {
  final FirebaseFirestore _db = FirebaseFirestore.instance;
  static const _timeout = Duration(seconds: 10);

  @override
  Stream<DailyReport?> streamReport(String repoId, String date) {
    return _db
        .doc('${FirestorePaths.dailyReports(repoId)}/$date')
        .snapshots()
        .map((snap) {
      final data = snap.data();
      if (data == null) return null;
      return DailyReport.fromMap(data, snap.id);
    });
  }

  @override
  Future<DailyReport?> getReport(String repoId, String date) async {
    final snap = await _db
        .doc('${FirestorePaths.dailyReports(repoId)}/$date')
        .get()
        .timeout(_timeout);
    final data = snap.data();
    if (data == null) return null;
    return DailyReport.fromMap(data, snap.id);
  }

  @override
  Stream<List<DailyReport>> streamReportsInRange(
    String repoId,
    String startDate,
    String endDate,
  ) {
    // YYYY-MM-DD strings sort lexicographically, so a plain string range over
    // the doc id (`date` field) gives the inclusive day window.
    return _db
        .collection(FirestorePaths.dailyReports(repoId))
        .where(FieldPath.documentId, isGreaterThanOrEqualTo: startDate)
        .where(FieldPath.documentId, isLessThanOrEqualTo: endDate)
        .snapshots()
        .map((snap) => snap.docs
            // Drop composite range docs (`{start}_{end}`) — keep one per day.
            .where((d) => !d.id.contains('_'))
            .map((d) => DailyReport.fromMap(d.data(), d.id))
            .toList());
  }
}
