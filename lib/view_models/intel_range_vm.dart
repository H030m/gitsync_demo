import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart' show DateTimeRange;

/// One shared date range for the whole Daily intelligence hub. A single picker
/// drives all three tabs (Summary / Commits / Discord) through this notifier;
/// the [DailyViewPage] listens and fans the value out to each tab's ViewModel.
///
/// `null` range = each tab falls back to its own default (Summary: today,
/// Commits: Recent 50, Discord: today). Not persisted across restarts.
class IntelRangeViewModel with ChangeNotifier {
  DateTimeRange? _range;

  /// The shared inclusive day range, or null when no range is selected.
  DateTimeRange? get range => _range;

  bool get hasRange => _range != null;

  /// Picks (or re-picks) the shared range. No-ops if unchanged.
  void setRange(DateTimeRange range) {
    if (_range == range) return;
    _range = range;
    notifyListeners();
  }

  /// Clears the shared range — every tab returns to its default.
  void clear() {
    if (_range == null) return;
    _range = null;
    notifyListeners();
  }
}
