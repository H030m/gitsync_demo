import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/daily_report.dart';
import '../repositories/daily_report_repo.dart';
import '../services/functions_service.dart';

/// Streams the AI report for the selected period (a single day by default,
/// today) and triggers regeneration. The user can widen the period via
/// [setRange] — multi-day reports live under the `{start}_{end}` doc id
/// (see functions/src/flows/summarizeDay.ts `reportDocId`).
class DailyReportViewModel with ChangeNotifier {
  DailyReportViewModel({
    required String repoId,
    DateTime? date,
    DailyReportRepository? reportRepository,
    FunctionsService? functionsService,
  })  : _repoId = repoId,
        _start = date ?? DateTime.now(),
        _end = date ?? DateTime.now(),
        _repo = reportRepository ?? DailyReportRepository(),
        _functions = functionsService ?? FunctionsService() {
    _subscribe();
  }

  final String _repoId;
  DateTime _start;
  DateTime _end;
  final DailyReportRepository _repo;
  final FunctionsService _functions;
  StreamSubscription<DailyReport?>? _sub;
  StreamSubscription<List<DailyReport>>? _rangeSub;

  DailyReport? _report;
  DailyReport? get report => _report;

  // Per-day reports for the selected multi-day range, keyed by YYYY-MM-DD. Only
  // populated while a range is active; the Summary tab renders one card per day
  // in [rangeDays] and looks the report up here.
  Map<String, DailyReport> _reportsByDay = {};

  /// The fetched report for [dayKey] (YYYY-MM-DD), or null if that day has none.
  /// In the single-day default the report streams into [_report]; in a range it
  /// streams into the per-day [_reportsByDay] map.
  DailyReport? reportForDay(String dayKey) =>
      isSingleDay ? (dayKey == startKey ? _report : null) : _reportsByDay[dayKey];

  /// Whether the current selection spans more than one calendar day. When true
  /// the Summary tab shows per-day cards; when false it shows today's single
  /// report (the default, no-range behavior).
  bool get hasRange => !isSingleDay;

  bool _loading = true;
  bool get loading => _loading;

  bool _regenerating = false;
  bool get regenerating => _regenerating;

  // YYYY-MM-DD keys currently generating via the per-day "Generate report"
  // button, so each card can show its own spinner.
  final Set<String> _generatingDays = {};
  bool isGeneratingDay(String dayKey) => _generatingDays.contains(dayKey);

  DateTime get rangeStart => _start;
  DateTime get rangeEnd => _end;

  /// The inclusive list of calendar days in the selected range, earliest first.
  /// One [DailyReport] card is rendered per entry.
  List<DateTime> get rangeDays {
    final days = <DateTime>[];
    var d = DateTime(_start.year, _start.month, _start.day);
    final last = DateTime(_end.year, _end.month, _end.day);
    while (!d.isAfter(last)) {
      days.add(d);
      d = d.add(const Duration(days: 1));
    }
    return days;
  }

  static String dayKeyOf(DateTime d) => _dayKey(d);

  /// True when the selected period is a single calendar day.
  bool get isSingleDay => _dayKey(_start) == _dayKey(_end);

  static String _dayKey(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-'
      '${d.month.toString().padLeft(2, '0')}-'
      '${d.day.toString().padLeft(2, '0')}';

  String get startKey => _dayKey(_start);
  String get endKey => _dayKey(_end);

  /// Report doc id for the current period (mirrors the backend's contract).
  String get docKey => isSingleDay ? startKey : '${startKey}_$endKey';

  void _subscribe() {
    _sub?.cancel();
    _rangeSub?.cancel();
    _loading = true;
    _report = null;
    _reportsByDay = {};
    if (isSingleDay) {
      // Default (no range): the single-day report card behavior.
      _sub = _repo.streamReport(_repoId, docKey).listen((report) {
        _report = report;
        _loading = false;
        notifyListeners();
      });
    } else {
      // Range: one report per day, rendered as collapsible per-day cards.
      _rangeSub = _repo
          .streamReportsInRange(_repoId, startKey, endKey)
          .listen((reports) {
        _reportsByDay = {for (final r in reports) r.date: r};
        _loading = false;
        notifyListeners();
      });
    }
  }

  /// Re-points the stream at the report for [start]..[end] (inclusive days).
  void setRange(DateTime start, DateTime end) {
    _start = start;
    _end = end;
    _subscribe();
    notifyListeners();
  }

  /// Returns to the default single-day (today) view.
  void clearRange() {
    final now = DateTime.now();
    setRange(now, now);
  }

  // Manual trigger for the AI-generated period report. [language] (W6) is the
  // English language NAME for the app locale; passed so the regenerated
  // narrative comes back in the user's language.
  Future<void> regenerate({String? language}) async {
    if (_regenerating) return;
    _regenerating = true;
    notifyListeners();
    try {
      await _functions.summarizeDay(
        repoId: _repoId,
        startDate: startKey,
        endDate: endKey,
        language: language,
      );
    } finally {
      _regenerating = false;
      notifyListeners();
    }
  }

  /// Generates (or regenerates) the report for a single [day] — used by the
  /// per-day cards' "產生日報" button. Calls `summarizeDay` with start == end.
  /// [language] (W6) is the English language NAME for the app locale.
  Future<void> generateDay(DateTime day, {String? language}) async {
    final key = _dayKey(day);
    if (_generatingDays.contains(key)) return;
    _generatingDays.add(key);
    notifyListeners();
    try {
      await _functions.summarizeDay(
        repoId: _repoId,
        startDate: key,
        endDate: key,
        language: language,
      );
    } finally {
      _generatingDays.remove(key);
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    _rangeSub?.cancel();
    super.dispose();
  }
}
