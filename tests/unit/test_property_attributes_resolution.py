"""Unit tests for attribute resolution (no DB)."""

from app.domain.entities.property import ClassProperty, Property, PropertyType
from app.features.properties.attributes import (
    default_columns_for_value,
    default_value_from_columns,
    is_empty_value,
    resolve_attributes,
)


def make_prop(**overrides) -> Property:
    base = dict(
        id=1, uuid="prop-1", name="P",
        type=PropertyType.SELECTION,
    )
    base.update(overrides)
    return Property(**base)


def make_edge(**overrides) -> ClassProperty:
    base = dict(id=1, uuid="cp-1", class_node_id=10, property_id=1)
    base.update(overrides)
    return ClassProperty(**base)


def test_property_base_applies_without_edges():
    eff = resolve_attributes(make_prop(required=True), [])
    assert eff.required is True
    assert eff.readonly is False
    assert eff.hide_when_empty is False


def test_nearest_edge_override_wins():
    far = make_edge(id=2, class_node_id=99, required=True)
    near = make_edge(required=False)
    eff = resolve_attributes(make_prop(required=True), [near, far])
    assert eff.required is False  # nearest explicit false beats base true


def test_null_override_inherits():
    edge = make_edge(required=None, hide_when_empty=True)
    eff = resolve_attributes(make_prop(required=True), [edge])
    assert eff.required is True        # inherited from base
    assert eff.hide_when_empty is True  # edge override


def test_default_resolution_edge_then_base():
    edge_no_default = make_edge()
    eff = resolve_attributes(make_prop(default_selection_id=42), [edge_no_default])
    assert eff.default_value == 42
    edge_with_default = make_edge(default_selection_id=7)
    eff = resolve_attributes(make_prop(default_selection_id=42), [edge_with_default])
    assert eff.default_value == 7


def test_default_value_from_columns_keeps_false_and_zero():
    edge = make_edge(default_boolean=False)
    assert default_value_from_columns(edge, PropertyType.BOOLEAN) is False
    edge2 = make_edge(default_integer=0)
    assert default_value_from_columns(edge2, PropertyType.INTEGER) == 0


def test_default_value_from_columns_ignores_cross_type_leftovers():
    """Values in columns not mapped for the type must not resolve as defaults."""
    edge = make_edge(default_text="stale")
    assert default_value_from_columns(edge, PropertyType.SELECTION) is None
    edge2 = make_edge(default_selection_id=42)
    assert default_value_from_columns(edge2, PropertyType.TEXT) is None


def test_default_value_from_columns_unmapped_type_returns_none():
    edge = make_edge(default_text="2024-01-01/2024-01-31")
    assert default_value_from_columns(edge, PropertyType.DATE_RANGE) is None


def test_default_columns_for_value():
    assert default_columns_for_value(PropertyType.SELECTION, 5) == {"default_selection_id": 5}
    assert default_columns_for_value(PropertyType.BOOLEAN, False) == {"default_boolean": False}
    assert default_columns_for_value(PropertyType.TEXT, "hi") == {"default_text": "hi"}
    assert default_columns_for_value(PropertyType.SELECTION, None) == {}
    assert default_columns_for_value(PropertyType.SELECTION, "") == {}
    assert default_columns_for_value(PropertyType.SELECTION, []) == {}


def test_default_columns_for_value_all_mapped_types():
    """Every type maps to its declared typed column (or none for DATE_RANGE)."""
    assert default_columns_for_value(PropertyType.INTEGER, 1) == {"default_integer": 1}
    assert default_columns_for_value(PropertyType.FLOAT, 1.5) == {"default_float": 1.5}
    assert default_columns_for_value(PropertyType.BOOLEAN, True) == {"default_boolean": True}
    assert default_columns_for_value(PropertyType.TEXT, "x") == {"default_text": "x"}
    assert default_columns_for_value(PropertyType.URL, "https://x") == {"default_text": "https://x"}
    assert default_columns_for_value(PropertyType.EMAIL, "a@b.c") == {"default_text": "a@b.c"}
    assert default_columns_for_value(PropertyType.NODE, 7) == {"default_node_id": 7}
    assert default_columns_for_value(PropertyType.IMAGE, 8) == {"default_node_id": 8}
    assert default_columns_for_value(PropertyType.DATE, 9) == {"default_node_id": 9}
    assert default_columns_for_value(PropertyType.SELECTION, 10) == {"default_selection_id": 10}
    # DATE_RANGE is intentionally unmapped (structured JSON, no typed column).
    assert default_columns_for_value(PropertyType.DATE_RANGE, {"start": "2024-01-01"}) == {}


def test_resolve_attributes_readonly_edge_then_base():
    """Readonly resolves nearest-non-NULL edge override, else the property base."""
    eff = resolve_attributes(make_prop(readonly=False), [])
    assert eff.readonly is False
    far = make_edge(id=2, class_node_id=99, readonly=True)
    near = make_edge(readonly=None)
    eff = resolve_attributes(make_prop(readonly=False), [near, far])
    assert eff.readonly is True  # nearest non-NULL override (far) wins
    near_off = make_edge(readonly=False)
    eff = resolve_attributes(make_prop(readonly=True), [near_off, far])
    assert eff.readonly is False  # explicit nearest false beats base true


def test_attribute_error_codes():
    from app.features.properties.attributes import (
        ReadonlyPropertyError,
        RequiredPropertyError,
    )

    assert RequiredPropertyError("x").code == "required_property"
    assert ReadonlyPropertyError("x").code == "readonly_property"


def test_is_empty_value():
    assert is_empty_value(None) and is_empty_value("") and is_empty_value([])
    assert not is_empty_value(0) and not is_empty_value(False) and not is_empty_value("x")
