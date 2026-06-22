"""Unit tests for date range utilities and QueryAST compilation."""

from __future__ import annotations

from datetime import date

import pytest

from app.domain.entities.constants import (
    generate_day_uuid,
    generate_month_uuid,
    generate_year_uuid,
)
from app.domain.entities.query_ast import (
    GroupNode,
    LogicType,
    PropertyCondition,
    PropertyOperator,
    PropertyType,
    QueryAST,
    ScopeNode,
    ScopeType,
)
from app.domain.services.query_ast_sql import generate_sql_from_ast
from app.utils.date_range import (
    DateRangeGranularity,
    date_uuid_granularity,
    date_uuid_to_date,
    normalize_date_range,
    normalize_date_range_value,
)

pytestmark = pytest.mark.unit


class TestNormalizeDateRange:
    """Tests for normalize_date_range."""

    def test_day_range_passthrough(self):
        result = normalize_date_range("2025-06-10", "2025-06-15", "day")
        assert result["start"] == "2025-06-10"
        assert result["end"] == "2025-06-15"
        assert result["granularity"] == "day"
        assert result["start_uuid"] == generate_day_uuid(date(2025, 6, 10))
        assert result["end_uuid"] == generate_day_uuid(date(2025, 6, 15))

    def test_month_range_canonical(self):
        result = normalize_date_range("2025-06-10", "2025-08-20", "month")
        assert result["start"] == "2025-06-01"
        assert result["end"] == "2025-08-31"
        assert result["granularity"] == "month"
        assert result["start_uuid"] == generate_month_uuid(2025, 6)
        assert result["end_uuid"] == generate_month_uuid(2025, 8)

    def test_year_range_canonical(self):
        result = normalize_date_range("2025-03-15", "2027-01-10", "year")
        assert result["start"] == "2025-01-01"
        assert result["end"] == "2027-12-31"
        assert result["granularity"] == "year"
        assert result["start_uuid"] == generate_year_uuid(2025)
        assert result["end_uuid"] == generate_year_uuid(2027)

    def test_single_day_range(self):
        result = normalize_date_range("2025-06-10", "2025-06-10", "day")
        assert result["start"] == result["end"] == "2025-06-10"

    def test_start_after_end_raises(self):
        with pytest.raises(ValueError, match="Start date must be before or equal to end date"):
            normalize_date_range("2025-06-15", "2025-06-10", "day")

    def test_invalid_granularity_raises(self):
        with pytest.raises(ValueError, match="Invalid granularity"):
            normalize_date_range("2025-06-10", "2025-06-15", "week")

    def test_accepts_date_objects(self):
        result = normalize_date_range(date(2025, 6, 10), date(2025, 6, 15), "day")
        assert result["start"] == "2025-06-10"
        assert result["end"] == "2025-06-15"


class TestNormalizeDateRangeValue:
    """Tests for normalize_date_range_value."""

    def test_from_dict(self):
        value = {
            "start": "2025-06-10",
            "end": "2025-06-15",
            "granularity": "day",
        }
        result = normalize_date_range_value(value)
        assert result.startswith('{"')
        assert '"end":"2025-06-15"' in result
        assert '"start":"2025-06-10"' in result
        assert '"granularity":"day"' in result

    def test_from_json_string(self):
        value = '{"start": "2025-06-10", "end": "2025-06-15", "granularity": "day"}'
        result = normalize_date_range_value(value)
        assert '"end":"2025-06-15"' in result

    def test_missing_fields_raises(self):
        with pytest.raises(ValueError, match="must include start, end, and granularity"):
            normalize_date_range_value({"start": "2025-06-10"})

    def test_invalid_json_raises(self):
        with pytest.raises(ValueError, match="not valid JSON"):
            normalize_date_range_value("not-json")


class TestDateUuidParsing:
    """Tests for date UUID helpers."""

    def test_date_uuid_to_date_day(self):
        uuid = generate_day_uuid(date(2025, 6, 10))
        assert date_uuid_to_date(uuid) == date(2025, 6, 10)

    def test_date_uuid_to_date_month(self):
        uuid = generate_month_uuid(2025, 6)
        assert date_uuid_to_date(uuid) == date(2025, 6, 1)

    def test_date_uuid_to_date_year(self):
        uuid = generate_year_uuid(2025)
        assert date_uuid_to_date(uuid) == date(2025, 1, 1)

    def test_date_uuid_granularity(self):
        assert date_uuid_granularity(generate_day_uuid(date(2025, 6, 10))) == DateRangeGranularity.DAY
        assert date_uuid_granularity(generate_month_uuid(2025, 6)) == DateRangeGranularity.MONTH
        assert date_uuid_granularity(generate_year_uuid(2025)) == DateRangeGranularity.YEAR

    def test_invalid_uuid_raises(self):
        with pytest.raises(ValueError, match="Not a date UUID"):
            date_uuid_to_date("00000000-0000-0000-0000-000000000000")


class TestQueryAstDateRange:
    """Tests for QueryAST SQL generation with date_range conditions."""

    def _build_ast(self, value: str) -> QueryAST:
        return QueryAST(
            scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE),
            root_group=GroupNode(
                logic=LogicType.AND,
                children=[
                    PropertyCondition(
                        property_name="When",
                        property_uuid="00000000-0000-0000-0000-000000000abc",
                        property_type=PropertyType.DATE_RANGE,
                        operator=PropertyOperator.CONTAINS,
                        value=value,
                    ),
                ],
            ),
        )

    def test_contains_day_compiles(self):
        day_uuid = generate_day_uuid(date(2025, 6, 10))
        sql, params = generate_sql_from_ast(self._build_ast(day_uuid), workspace_id=1)
        assert "value_text::jsonb->>'start'" in sql
        assert "value_text::jsonb->>'end'" in sql
        assert params["workspace_id"] == 1
        target_params = [v for v in params.values() if v == "2025-06-10"]
        assert len(target_params) == 1

    def test_contains_month_compiles(self):
        month_uuid = generate_month_uuid(2025, 6)
        sql, params = generate_sql_from_ast(self._build_ast(month_uuid), workspace_id=1)
        assert "value_text::jsonb->>'start'" in sql
        target_params = [v for v in params.values() if v == "2025-06-01"]
        assert len(target_params) == 1

    def test_contains_year_compiles(self):
        year_uuid = generate_year_uuid(2025)
        sql, params = generate_sql_from_ast(self._build_ast(year_uuid), workspace_id=1)
        target_params = [v for v in params.values() if v == "2025-01-01"]
        assert len(target_params) == 1

    def test_invalid_date_uuid_ignored(self):
        sql, _params = generate_sql_from_ast(
            self._build_ast("00000000-0000-0000-0000-000000000000"), workspace_id=1
        )
        assert "value_text::jsonb" not in sql
