"""Pure unit tests for the recurrence engine."""

from datetime import date

import pytest

from app.domain.entities import TaskRecurrence
from app.domain.services.recurrence_engine import describe_rule, has_ended, next_occurrence


class TestNextOccurrence:
    def test_daily_advances_by_interval(self):
        rule = TaskRecurrence(rule_type="daily", interval=3)
        assert next_occurrence(date(2026, 1, 10), rule) == date(2026, 1, 13)

    def test_weekday_skips_weekend(self):
        rule = TaskRecurrence(rule_type="weekday", interval=1)
        # Friday -> Monday
        assert next_occurrence(date(2026, 1, 9), rule) == date(2026, 1, 12)

    def test_weekly_same_weekday(self):
        rule = TaskRecurrence(rule_type="weekly", interval=1)
        assert next_occurrence(date(2026, 1, 12), rule) == date(2026, 1, 19)

    def test_weekly_with_weekdays(self):
        rule = TaskRecurrence(rule_type="weekly", interval=1, weekdays=[1, 3, 5])
        # Monday -> Wednesday
        assert next_occurrence(date(2026, 1, 12), rule) == date(2026, 1, 14)

    def test_monthly_preserves_day(self):
        rule = TaskRecurrence(rule_type="monthly", interval=1, day_of_month=15)
        assert next_occurrence(date(2026, 1, 15), rule) == date(2026, 2, 15)

    def test_monthly_falls_back_to_last_day(self):
        rule = TaskRecurrence(rule_type="monthly", interval=1, day_of_month=31)
        assert next_occurrence(date(2026, 1, 31), rule) == date(2026, 2, 28)

    def test_monthly_by_weekday(self):
        rule = TaskRecurrence(rule_type="monthly", interval=1, week_of_month=2, weekdays=[1])
        # 2nd Monday of Feb 2026 is Feb 9
        assert next_occurrence(date(2026, 1, 12), rule) == date(2026, 2, 9)

    def test_yearly(self):
        rule = TaskRecurrence(rule_type="yearly", interval=1, month=6, day_of_month=15)
        assert next_occurrence(date(2026, 6, 15), rule) == date(2027, 6, 15)


class TestHasEnded:
    def test_end_after_count(self):
        rule = TaskRecurrence(rule_type="daily", interval=1, end_after_count=3)
        assert has_ended(rule, 3, date(2026, 1, 15)) is True
        assert has_ended(rule, 2, date(2026, 1, 15)) is False

    def test_end_date(self):
        rule = TaskRecurrence(rule_type="daily", interval=1, end_date=date(2026, 1, 15))
        assert has_ended(rule, 0, date(2026, 1, 16)) is True
        assert has_ended(rule, 0, date(2026, 1, 15)) is False


class TestDescribeRule:
    def test_daily(self):
        assert describe_rule(TaskRecurrence(rule_type="daily", interval=1)) == "Daily"
        assert describe_rule(TaskRecurrence(rule_type="daily", interval=3)) == "Every 3 days"

    def test_weekday(self):
        assert describe_rule(TaskRecurrence(rule_type="weekday")) == "Every weekday"

    def test_weekly(self):
        assert describe_rule(TaskRecurrence(rule_type="weekly", interval=1)) == "Weekly"
        assert describe_rule(TaskRecurrence(rule_type="weekly", interval=2)) == "Every 2 weeks"

    def test_weekly_with_days(self):
        assert (
            describe_rule(TaskRecurrence(rule_type="weekly", interval=1, weekdays=[1, 5]))
            == "Weekly on Monday, Friday"
        )

    def test_monthly(self):
        assert describe_rule(TaskRecurrence(rule_type="monthly", interval=1, day_of_month=15)) == "Monthly on day 15"

    def test_yearly(self):
        assert describe_rule(TaskRecurrence(rule_type="yearly", interval=1, month=6, day_of_month=15)) == "Yearly on June 15"
