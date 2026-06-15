import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:gitsync/l10n/app_locale.dart';
import 'package:gitsync/models/daily_report.dart';
import 'package:gitsync/repositories/daily_report_repo.dart';
import 'package:gitsync/services/functions_service.dart';
import 'package:gitsync/view_models/daily_report_vm.dart';

/// W6 (regenerate-with-locale) frontend wiring tests:
/// - the active locale maps to the English language NAME the backend expects;
/// - the daily-report regenerate forwards that name to summarizeDay.

/// Minimal repo: the VM subscribes to a single-day report on construction.
class _StubReportRepository implements DailyReportRepository {
  @override
  Stream<DailyReport?> streamReport(String repoId, String date) =>
      Stream<DailyReport?>.value(null);

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError(invocation.memberName.toString());
}

/// Captures the args passed to summarizeDay so the language wiring is observable.
class _CapturingFunctionsService implements FunctionsService {
  String? lastLanguage;
  String? lastStart;
  String? lastEnd;
  int calls = 0;

  @override
  Future<String> summarizeDay({
    required String repoId,
    required String startDate,
    String? endDate,
    String? language,
  }) async {
    calls++;
    lastStart = startDate;
    lastEnd = endDate;
    lastLanguage = language;
    return 'summary';
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError(invocation.memberName.toString());
}

void main() {
  group('AppLocale → backend language name (W6 convention)', () {
    test('en maps to "English"', () {
      expect(AppLocale.en.backendLanguage, 'English');
    });
    test('zhHant maps to "Traditional Chinese"', () {
      expect(AppLocale.zhHant.backendLanguage, 'Traditional Chinese');
    });
  });

  group('DailyReportViewModel regenerate forwards language', () {
    test('generateDay sends the mapped language to summarizeDay', () async {
      final functions = _CapturingFunctionsService();
      final vm = DailyReportViewModel(
        repoId: 'r',
        date: DateTime(2026, 6, 12),
        reportRepository: _StubReportRepository(),
        functionsService: functions,
      );
      await Future<void>.delayed(Duration.zero);

      await vm.generateDay(
        DateTime(2026, 6, 12),
        language: 'Traditional Chinese',
      );

      expect(functions.calls, 1);
      expect(functions.lastLanguage, 'Traditional Chinese');
      expect(functions.lastStart, '2026-06-12');
      expect(functions.lastEnd, '2026-06-12');
    });

    test('regenerate without a language sends none (default path)', () async {
      final functions = _CapturingFunctionsService();
      final vm = DailyReportViewModel(
        repoId: 'r',
        date: DateTime(2026, 6, 12),
        reportRepository: _StubReportRepository(),
        functionsService: functions,
      );
      await Future<void>.delayed(Duration.zero);

      await vm.regenerate();

      expect(functions.calls, 1);
      expect(functions.lastLanguage, isNull);
    });
  });
}
