import '../../core/constants/system.dart';

/// Task date derivation — the single home for the two date rules every
/// surface shares (the tasks screen's buckets/display, the home-screen
/// widget, the boot reminder reschedule). The web app is the source of
/// truth; these mirror its two rules, which are deliberately DIFFERENT:
///
///  - [taskDueDate] is the display/grouping date — the web buckets' driving
///    rule: the EARLIEST of Scheduled and Deadline, so a task never hides
///    behind its later date.
///  - [taskReminderDate] is the reminder moment — the web reminder rule
///    (the Google Tasks model): Scheduled WINS when set, else Deadline. A
///    reminder fires at the task's own moment, not at whichever date is
///    earlier.
///
/// The legacy free-key fallbacks ('due_date'/'deadline'/'scheduled'/
/// 'reminder') ride behind the system properties in both rules, unchanged
/// from the surfaces this helper replaces.
DateTime? extractTaskDate(dynamic value) {
  if (value == null) return null;
  if (value is DateTime) return value;
  if (value is String) {
    final parsed = DateTime.tryParse(value);
    if (parsed != null) return parsed;
  }
  return null;
}

DateTime? _earliest(Iterable<DateTime?> candidates) {
  DateTime? best;
  for (final candidate in candidates) {
    if (candidate == null) continue;
    if (best == null || candidate.isBefore(best)) best = candidate;
  }
  return best;
}

/// The display/grouping date: earliest of Scheduled/Deadline (legacy keys
/// as fallbacks) — the web buckets' driving rule.
DateTime? taskDueDate(Map<String, dynamic> properties) {
  return _earliest([
    extractTaskDate(properties[SystemPropertyUuids.taskScheduled]),
    extractTaskDate(properties[SystemPropertyUuids.taskDeadline]),
    extractTaskDate(properties['due_date']),
    extractTaskDate(properties['deadline']),
  ]);
}

/// The reminder moment: Scheduled wins when set, else Deadline (legacy
/// keys as fallbacks) — the web reminder rule.
DateTime? taskReminderDate(Map<String, dynamic> properties) {
  return extractTaskDate(properties[SystemPropertyUuids.taskScheduled]) ??
      extractTaskDate(properties[SystemPropertyUuids.taskDeadline]) ??
      extractTaskDate(properties['scheduled']) ??
      extractTaskDate(properties['reminder']) ??
      extractTaskDate(properties['due_date']) ??
      extractTaskDate(properties['deadline']);
}
