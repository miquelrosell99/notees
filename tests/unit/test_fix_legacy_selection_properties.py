"""Unit tests for scripts/fix_legacy_selection_properties.py.

The script repairs legacy migration-era selection schemas (type "select",
options under config.options with "id" keys, values wrapped as {"value": X})
by appending corrective operations to the relay log. These tests cover the
pure decision/normalization logic; the DB interaction is exercised by running
the script itself.
"""

import importlib.util
import sys
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "fix_legacy_selection_properties.py"

spec = importlib.util.spec_from_file_location("fix_legacy_selection_properties", SCRIPT_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

normalize_options = module.normalize_options
fold_schema_states = module.fold_schema_states
schema_repair_payload = module.schema_repair_payload
is_wrapped_value = module.is_wrapped_value
unwrap_value = module.unwrap_value


def _create(schema_id: str, **payload):
    return {"op_type": "propertySchema.create", "payload": {"schemaId": schema_id, **payload}}


def _update(schema_id: str, **payload):
    return {"op_type": "propertySchema.update", "payload": {"schemaId": schema_id, **payload}}


class TestNormalizeOptions:
    def test_legacy_id_keys_become_uuid_keys(self):
        raw = [{"id": "opt-1", "name": "Pending", "icon": "circle-outline", "sequence": 0}]
        assert normalize_options(raw) == [
            {"uuid": "opt-1", "name": "Pending", "icon": "circle-outline", "color": None, "sequence": 0}
        ]

    def test_modern_shape_passes_through(self):
        raw = [{"uuid": "opt-1", "name": "Done", "icon": None, "color": "green", "sequence": 3}]
        assert normalize_options(raw) == [
            {"uuid": "opt-1", "name": "Done", "icon": None, "color": "green", "sequence": 3}
        ]

    def test_entries_without_id_are_dropped(self):
        assert normalize_options([{"name": "NoId"}, "junk", None]) == []

    def test_non_list_returns_empty(self):
        assert normalize_options(None) == []
        assert normalize_options({}) == []


class TestFoldSchemaStates:
    def test_create_reads_legacy_config_options(self):
        states = fold_schema_states(
            [
                _create("s-1", type="select", config={"options": [{"id": "o1", "name": "A"}]}),
            ]
        )
        assert states["s-1"]["type"] == "select"
        assert states["s-1"]["options"] == [{"id": "o1", "name": "A"}]

    def test_later_update_wins(self):
        states = fold_schema_states(
            [
                _create("s-1", type="select"),
                _update("s-1", type="selection", options=[{"uuid": "o1", "name": "A"}]),
            ]
        )
        assert states["s-1"]["type"] == "selection"
        assert states["s-1"]["options"] == [{"uuid": "o1", "name": "A"}]

    def test_delete_marks_inactive(self):
        states = fold_schema_states(
            [
                _create("s-1", type="select"),
                {"op_type": "propertySchema.delete", "payload": {"schemaId": "s-1"}},
            ]
        )
        assert states["s-1"]["active"] is False


class TestSchemaRepairPayload:
    def test_select_schema_is_repaired(self):
        state = {
            "type": "select",
            "multi": False,
            "active": True,
            "options": [{"id": "o1", "name": "Backlog", "icon": "dots-circle", "sequence": 0}],
        }
        payload = schema_repair_payload("s-1", state)
        assert payload == {
            "schemaId": "s-1",
            "type": "selection",
            "options": [{"uuid": "o1", "name": "Backlog", "icon": "dots-circle", "color": None, "sequence": 0}],
        }

    def test_multi_select_becomes_multi_selection(self):
        state = {"type": "multi_select", "multi": False, "active": True, "options": []}
        payload = schema_repair_payload("s-1", state)
        assert payload is not None
        assert payload["type"] == "selection"
        assert payload["multi"] is True

    def test_repaired_schema_is_not_repaired_again(self):
        state = {"type": "selection", "multi": False, "active": True, "options": [{"uuid": "o1", "name": "A"}]}
        assert schema_repair_payload("s-1", state) is None

    def test_unrelated_types_are_untouched(self):
        for prop_type in ("text", "date", "node", "boolean", "integer"):
            state = {"type": prop_type, "multi": False, "active": True, "options": []}
            assert schema_repair_payload("s-1", state) is None

    def test_inactive_schema_is_untouched(self):
        state = {"type": "select", "multi": False, "active": False, "options": []}
        assert schema_repair_payload("s-1", state) is None


class TestValueWrapping:
    def test_wrapped_value_detected_and_unwrapped(self):
        wrapped = {"value": "62fe55a5-39f5-4c6f-a54a-d202ac05eab9"}
        assert is_wrapped_value(wrapped)
        assert unwrap_value(wrapped) == "62fe55a5-39f5-4c6f-a54a-d202ac05eab9"

    def test_bare_values_are_not_touched(self):
        assert not is_wrapped_value("62fe55a5-39f5-4c6f-a54a-d202ac05eab9")
        assert not is_wrapped_value(None)
        assert not is_wrapped_value({"value": "x", "other": 1})
        assert not is_wrapped_value(["a", "b"])
