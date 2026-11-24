import 'package:flutter_test/flutter_test.dart';
import 'package:notees/core/constants/system.dart';
import 'package:notees/domain/services/task_dates.dart';

void main() {
  group('taskDueDate (the display/grouping rule — earliest wins)', () {
    test('scheduled-only and deadline-only tasks both carry a date', () {
      expect(
        taskDueDate({SystemPropertyUuids.taskScheduled: '2026-11-26'}),
        DateTime(2026, 11, 26),
      );
      expect(
        taskDueDate({SystemPropertyUuids.taskDeadline: '2026-11-25'}),
        DateTime(2026, 11, 25),
      );
    });

    test('the EARLIER of the two wins when both are set', () {
      final properties = {
        SystemPropertyUuids.taskScheduled: '2026-11-30',
        SystemPropertyUuids.taskDeadline: '2026-11-25',
      };
      expect(taskDueDate(properties), DateTime(2026, 11, 25));
      expect(
        taskDueDate({
          SystemPropertyUuids.taskScheduled: '2026-11-20',
          SystemPropertyUuids.taskDeadline: '2026-11-25',
        }),
        DateTime(2026, 11, 20),
      );
    });

    test('legacy keys fall back behind the system properties', () {
      expect(taskDueDate({'due_date': '2026-12-01'}), DateTime(2026, 12, 1));
      expect(
        taskDueDate({
          SystemPropertyUuids.taskScheduled: '2026-11-26',
          'due_date': '2026-12-01',
        }),
        DateTime(2026, 11, 26),
      );
    });

    test('no dates and garbage values read as null, never throw', () {
      expect(taskDueDate({}), isNull);
      expect(taskDueDate({SystemPropertyUuids.taskScheduled: 'not-a-date'}), isNull);
      expect(taskDueDate({SystemPropertyUuids.taskDeadline: 42}), isNull);
    });
  });

  group('taskReminderDate (the reminder rule — Scheduled wins)', () {
    test('scheduled wins over an earlier deadline', () {
      final properties = {
        SystemPropertyUuids.taskScheduled: '2026-11-30',
        SystemPropertyUuids.taskDeadline: '2026-11-25',
      };
      expect(taskReminderDate(properties), DateTime(2026, 11, 30));
    });

    test('deadline drives only when scheduled is absent', () {
      expect(
        taskReminderDate({SystemPropertyUuids.taskDeadline: '2026-11-25'}),
        DateTime(2026, 11, 25),
      );
    });

    test('legacy keys fall back in order behind the system properties', () {
      expect(taskReminderDate({'scheduled': '2026-12-02'}), DateTime(2026, 12, 2));
      expect(taskReminderDate({'reminder': '2026-12-03'}), DateTime(2026, 12, 3));
      expect(taskReminderDate({'due_date': '2026-12-04'}), DateTime(2026, 12, 4));
      expect(
        taskReminderDate({
          SystemPropertyUuids.taskDeadline: '2026-11-25',
          'scheduled': '2026-12-02',
        }),
        DateTime(2026, 11, 25),
      );
    });

    test('a DateTime value passes through; no dates read as null', () {
      final when = DateTime(2026, 11, 26, 14, 30);
      expect(taskReminderDate({SystemPropertyUuids.taskScheduled: when}), when);
      expect(taskReminderDate({}), isNull);
    });
  });
}
