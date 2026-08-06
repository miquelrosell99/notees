# Property Attributes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Odoo-style field attributes — `required`, `default`, `readonly`, `hide_when_empty` — defined at property level with tri-state class-level overrides, enforced server-side, and make empty class-declared properties visible/fillable in list-view block rows.

**Architecture:** Attributes live as columns on `property` (base) and nullable override columns on `class_property` (NULL = inherit). A pure resolution module (`app/features/properties/attributes.py`) computes effective attributes per node+property by walking the node's class closure (`node.class_ids` + `class_extend` edges, nearest edge wins). Enforcement sits in `PropertyService.set_property_value` — the single choke point shared by REST and sync — with an `enforce_attributes=False` bypass for automations/seed. Frontend mirrors the same resolution for display and adds attribute editors to the property page and class editor.

**Tech Stack:** FastAPI + asyncpg + Pydantic v2 (backend), React 19 + TypeScript + TanStack Query + Zustand (frontend), PostgreSQL 17, pytest + Vitest.

Spec: `../specs/2026-07-13-property-attributes-design.md`

## Global Constraints

- All backend commands run in the dev container: `docker compose -f compose.dev.yaml exec -T backend uv run <cmd>`. Frontend: `docker compose -f compose.dev.yaml exec -T frontend <cmd>`.
- Migrations are idempotent `DO $$ ... END $$;` blocks appended to `app/db/schema/sql.py` (see line 1260-1308 for the established pattern). Fresh DBs and upgraded DBs must converge to the same schema.
- Public API uses UUIDs; internal joins use integer IDs. Never expose internal IDs in responses.
- Tri-state override semantics: an override column is `NULL` (inherit), `true` (force on), or `false` (force off). API payloads use explicit `null` to set inherit; Pydantic `model_fields_set` distinguishes "field absent" (no change) from "field null" (set NULL).
- "Empty" means `None`, `""`, or `[]`. For multi-value properties, required = at least one value.
- Commit after every task (Conventional Commits). Only stage the task's own files — other agents work concurrently in this repo.
- New error codes: `required_property`, `readonly_property` (400, structured detail).
- New exceptions subclass `ValueError` so the sync path (`app/features/sync/service_v2.py:462`) skips violating ops without new code.

## File Structure

**Backend — create:**
- `app/features/properties/attributes.py` — `EffectiveAttributes`, `resolve_attributes()`, `default_value_from_columns()`, `default_columns_for_value()`, `is_empty_value()`, `RequiredPropertyError`, `ReadonlyPropertyError`
- `tests/test_property_attributes.py` — integration tests (API + DB)
- `tests/unit/test_property_attributes_resolution.py` — pure resolution unit tests

**Backend — modify:**
- `app/db/schema/sql.py` — migration blocks (Tasks 1, 7)
- `app/db/schema/init.py` — task-status property seed: required + Pending default (Task 7)
- `app/domain/entities/property.py` — `Property` + `ClassProperty` fields (Task 2)
- `app/features/properties/repository.py` — row mapping, `add_class_property` default fix, `update_class_property` extension, `get_class_property_edges_for_node()` (Tasks 3, 5)
- `app/features/properties/service.py` — `update_property` extension, `update_class_property` extension, enforcement in `set_property_value` (Tasks 4, 5)
- `app/features/properties/models.py` — request/response fields (Task 4)
- `app/features/properties/router/crud.py` — PUT property wiring (Task 4)
- `app/features/properties/router/classes.py` — response mapping + PATCH wiring (Task 4)
- `app/features/properties/router/values.py` — error-code mapping (Task 5)
- `app/features/nodes/class_management_service.py` — property-level default fallback (Task 6)
- `app/features/tasks/service.py` — automation writes pass `enforce_attributes=False` (Task 5)

**Frontend — create:**
- `frontend/src/features/properties/components/DefaultValueEditor.tsx` — shared type-appropriate default editor (Task 10)
- `frontend/src/features/properties/components/ClassPropertiesEditor.test.tsx` (Task 11)

**Frontend — modify:**
- `frontend/src/types/api.ts` — `Property`, `ClassProperty` fields (Task 8)
- `frontend/src/api/properties.ts` — `updateProperty`, `updateClassProperty` payloads (Task 8)
- `frontend/src/features/properties/components/PropertiesSection.tsx` — effective hidden/readonly/required display (Task 9)
- `frontend/src/features/content/components/blocks/BlockRow.tsx` — drop `onlyWithValues` (Task 9)
- `frontend/src/features/properties/components/PropertyConfigSection.tsx` — attributes UI (Task 10)
- `frontend/src/features/properties/components/ClassPropertiesEditor.tsx` — tri-states + default override (Task 11)

---

### Task 1: Schema migration — attribute columns

**Files:**
- Modify: `app/db/schema/sql.py` (append after line 1308)
- Test: `tests/test_property_attributes.py` (create)

**Interfaces:**
- Produces: columns `property.required`, `property.readonly`, `property.hide_when_empty` (NOT NULL DEFAULT FALSE); `property.default_integer BIGINT`, `default_float DOUBLE PRECISION`, `default_text TEXT`, `default_boolean BOOLEAN`, `default_node_id BIGINT REFERENCES node(id) ON DELETE SET NULL`, `default_selection_id BIGINT REFERENCES property_selection_line(id) ON DELETE SET NULL`; `class_property.readonly BOOLEAN` (nullable), `class_property.hide_when_empty BOOLEAN` (nullable); `class_property.required` nullable with existing `false` rows migrated to NULL.

- [ ] **Step 1: Write the failing test**

Create `tests/test_property_attributes.py`:

```python
"""Integration tests for property attributes (required/default/readonly/hide-when-empty)."""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_attribute_columns_exist(db_pool):
    """Migration adds attribute columns with correct nullability."""
    rows = await db_pool.fetch(
        """
        SELECT table_name, column_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE (table_name = 'property' AND column_name IN
               ('required', 'readonly', 'hide_when_empty', 'default_integer',
                'default_float', 'default_text', 'default_boolean',
                'default_node_id', 'default_selection_id'))
           OR (table_name = 'class_property' AND column_name IN
               ('required', 'readonly', 'hide_when_empty'))
        """
    )
    cols = {(r["table_name"], r["column_name"]): r for r in rows}
    for col in ("required", "readonly", "hide_when_empty"):
        assert ("property", col) in cols, f"property.{col} missing"
        assert cols[("property", col)]["is_nullable"] == "NO"
        assert cols[("property", col)]["column_default"] == "false"
    for col in ("required", "readonly", "hide_when_empty"):
        assert ("class_property", col) in cols, f"class_property.{col} missing"
        assert cols[("class_property", col)]["is_nullable"] == "YES"
    for col in ("default_integer", "default_float", "default_text",
                "default_boolean", "default_node_id", "default_selection_id"):
        assert ("property", col) in cols, f"property.{col} missing"


@pytest.mark.asyncio
async def test_class_property_required_false_migrated_to_null(db_pool):
    """Pre-existing required=false rows mean 'inherit' (NULL), not 'force off'."""
    # The seed creates class_property rows with required=false; after migration
    # none of them may hold an explicit false.
    count = await db_pool.fetchval(
        "SELECT count(*) FROM class_property WHERE required = false"
    )
    assert count == 0
```

Check `tests/conftest.py` for the pool fixture name first — if no `db_pool` fixture exists, add one:

```python
@pytest.fixture
async def db_pool(app):
    from app.db.connection import get_pool
    pool = get_pool()
    yield pool
```

(Match the existing conftest's app/pool wiring; several integration tests already touch the DB directly — grep `tests/` for `fetchval` to copy the established pattern.)

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/test_property_attributes.py -x --no-cov`
Expected: FAIL — columns missing / `db_pool` fixture provides DB access.

- [ ] **Step 3: Append the migration blocks**

Append to `app/db/schema/sql.py` (immediately after the `node_property` sequence/hidden block ending at line 1308):

```sql
-- ============================================================
-- MIGRATIONS: PROPERTY ATTRIBUTES (required/default/readonly/hide-when-empty)
-- ============================================================

-- Migration: attribute base columns on property
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'property' AND column_name = 'required'
    ) THEN
        ALTER TABLE property ADD COLUMN required BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'property' AND column_name = 'readonly'
    ) THEN
        ALTER TABLE property ADD COLUMN readonly BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'property' AND column_name = 'hide_when_empty'
    ) THEN
        ALTER TABLE property ADD COLUMN hide_when_empty BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;

-- Migration: typed default columns on property (mirrors class_property defaults)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'property' AND column_name = 'default_integer'
    ) THEN
        ALTER TABLE property ADD COLUMN default_integer BIGINT DEFAULT NULL;
        ALTER TABLE property ADD COLUMN default_float DOUBLE PRECISION DEFAULT NULL;
        ALTER TABLE property ADD COLUMN default_text TEXT DEFAULT NULL;
        ALTER TABLE property ADD COLUMN default_boolean BOOLEAN DEFAULT NULL;
        ALTER TABLE property ADD COLUMN default_node_id BIGINT DEFAULT NULL
            REFERENCES node(id) ON DELETE SET NULL;
        ALTER TABLE property ADD COLUMN default_selection_id BIGINT DEFAULT NULL
            REFERENCES property_selection_line(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Migration: tri-state overrides on class_property
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'class_property' AND column_name = 'readonly'
    ) THEN
        ALTER TABLE class_property ADD COLUMN readonly BOOLEAN DEFAULT NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'class_property' AND column_name = 'hide_when_empty'
    ) THEN
        ALTER TABLE class_property ADD COLUMN hide_when_empty BOOLEAN DEFAULT NULL;
    END IF;
END $$;

-- Migration: class_property.required becomes tri-state (NULL = inherit).
-- Existing false rows never had enforcement semantics, so they become NULL.
DO $$
BEGIN
    ALTER TABLE class_property ALTER COLUMN required DROP NOT NULL;
    ALTER TABLE class_property ALTER COLUMN required DROP DEFAULT;
    UPDATE class_property SET required = NULL WHERE required = FALSE;
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;
```

- [ ] **Step 4: Run test to verify it passes**

Restart the backend so the schema module re-runs (migrations execute at startup):
Run: `docker compose -f compose.dev.yaml restart backend && docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/test_property_attributes.py -x --no-cov`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add app/db/schema/sql.py tests/test_property_attributes.py tests/conftest.py
git commit -m "feat(properties): add attribute columns to property and class_property"
```

(Only add `tests/conftest.py` if the fixture was needed.)

---

### Task 2: Domain entities + resolution module

**Files:**
- Modify: `app/domain/entities/property.py` (`Property` dataclass ~line 81-138, `ClassProperty` ~line 372-394)
- Create: `app/features/properties/attributes.py`
- Test: `tests/unit/test_property_attributes_resolution.py`

**Interfaces:**
- Produces:
  - `Property` gains: `required: bool = False`, `readonly: bool = False`, `hide_when_empty: bool = False`, `default_integer: int | None = None`, `default_float: float | None = None`, `default_text: str | None = None`, `default_boolean: bool | None = None`, `default_node_id: int | None = None`, `default_selection_id: int | None = None`
  - `ClassProperty.required` becomes `bool | None = None`; gains `readonly: bool | None = None`, `hide_when_empty: bool | None = None`
  - `attributes.EffectiveAttributes` dataclass: `required: bool`, `readonly: bool`, `hide_when_empty: bool`, `default_value: Any | None`
  - `attributes.resolve_attributes(prop: Property, edges: list[ClassProperty]) -> EffectiveAttributes` — `edges` ordered nearest-class-first; first edge with a non-NULL override wins per attribute, else the property base; `default_value` = first non-NULL among edge defaults (nearest first), else property defaults, via `default_value_from_columns`
  - `attributes.default_value_from_columns(obj: Any) -> Any | None` — returns the first non-None of `default_integer, default_float, default_text, default_boolean, default_node_id, default_selection_id` (explicit `is not None` checks — `False`/`0` are valid defaults)
  - `attributes.default_columns_for_value(prop_type: PropertyType, value: Any) -> dict[str, Any]` — maps a public value to the matching typed column; empty value → `{}`
  - `attributes.is_empty_value(value: Any) -> bool` — `None`, `""`, or `[]`
  - `attributes.RequiredPropertyError(ValueError)` with `.code = "required_property"`; `attributes.ReadonlyPropertyError(ValueError)` with `.code = "readonly_property"`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/test_property_attributes_resolution.py`:

```python
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
        id=1, uuid="prop-1", workspace_id=1, name="P",
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
    assert default_value_from_columns(edge) is False
    edge2 = make_edge(default_integer=0)
    assert default_value_from_columns(edge2) == 0


def test_default_columns_for_value():
    assert default_columns_for_value(PropertyType.SELECTION, 5) == {"default_selection_id": 5}
    assert default_columns_for_value(PropertyType.BOOLEAN, False) == {"default_boolean": False}
    assert default_columns_for_value(PropertyType.TEXT, "hi") == {"default_text": "hi"}
    assert default_columns_for_value(PropertyType.SELECTION, None) == {}
    assert default_columns_for_value(PropertyType.SELECTION, "") == {}


def test_is_empty_value():
    assert is_empty_value(None) and is_empty_value("") and is_empty_value([])
    assert not is_empty_value(0) and not is_empty_value(False) and not is_empty_value("x")
```

If `Property`/`ClassProperty` construction requires more fields than shown, adjust `make_prop`/`make_edge` to the dataclass' required fields (read `app/domain/entities/property.py` first).

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/unit/test_property_attributes_resolution.py -x --no-cov`
Expected: FAIL — `app.features.properties.attributes` does not exist.

- [ ] **Step 3: Extend the entities**

In `app/domain/entities/property.py`, add to the `Property` dataclass (after the `validation_rules` field):

```python
    required: bool = False
    readonly: bool = False
    hide_when_empty: bool = False
    default_integer: int | None = None
    default_float: float | None = None
    default_text: str | None = None
    default_boolean: bool | None = None
    default_node_id: int | None = None
    default_selection_id: int | None = None
```

In the same file, change `ClassProperty.required` to `bool | None = None` and add `readonly: bool | None = None` and `hide_when_empty: bool | None = None`.

- [ ] **Step 4: Create the resolution module**

Create `app/features/properties/attributes.py`:

```python
"""Property attribute resolution: property-level bases with class-edge overrides.

Attributes (required, readonly, hide_when_empty, default) are defined on the
property itself. Each class_property edge may override them tri-state
(NULL = inherit). Resolution walks edges ordered nearest-class-first; the
first non-NULL override wins, otherwise the property base applies.
"""

from dataclasses import dataclass
from typing import Any

from app.domain.entities.property import ClassProperty, Property, PropertyType

DEFAULT_COLUMNS = (
    "default_integer",
    "default_float",
    "default_text",
    "default_boolean",
    "default_node_id",
    "default_selection_id",
)

_TYPE_DEFAULT_COLUMN: dict[PropertyType, str] = {
    PropertyType.INTEGER: "default_integer",
    PropertyType.FLOAT: "default_float",
    PropertyType.TEXT: "default_text",
    PropertyType.BOOLEAN: "default_boolean",
    PropertyType.NODE: "default_node_id",
    PropertyType.SELECTION: "default_selection_id",
}


class RequiredPropertyError(ValueError):
    code = "required_property"


class ReadonlyPropertyError(ValueError):
    code = "readonly_property"


@dataclass(frozen=True)
class EffectiveAttributes:
    required: bool
    readonly: bool
    hide_when_empty: bool
    default_value: Any | None


def is_empty_value(value: Any) -> bool:
    return value is None or value == "" or value == []


def default_value_from_columns(obj: Any) -> Any | None:
    """First non-None typed default column (False/0 are valid defaults)."""
    for col in DEFAULT_COLUMNS:
        val = getattr(obj, col, None)
        if val is not None:
            return val
    return None


def default_columns_for_value(prop_type: PropertyType, value: Any) -> dict[str, Any]:
    """Map a public default value to its typed column; empty -> no columns."""
    if is_empty_value(value):
        return {}
    column = _TYPE_DEFAULT_COLUMN.get(prop_type)
    if column is None:
        return {}
    return {column: value}


def _resolve_flag(base: bool, edges: list[ClassProperty], attr: str) -> bool:
    for edge in edges:
        override = getattr(edge, attr, None)
        if override is not None:
            return override
    return base


def resolve_attributes(prop: Property, edges: list[ClassProperty]) -> EffectiveAttributes:
    """Resolve effective attributes for a node+property.

    `edges` must be ordered nearest-class-first (see
    PropertyRepository.get_class_property_edges_for_node).
    """
    default: Any | None = None
    for edge in edges:
        default = default_value_from_columns(edge)
        if default is not None:
            break
    if default is None:
        default = default_value_from_columns(prop)
    return EffectiveAttributes(
        required=_resolve_flag(prop.required, edges, "required"),
        readonly=_resolve_flag(prop.readonly, edges, "readonly"),
        hide_when_empty=_resolve_flag(prop.hide_when_empty, edges, "hide_when_empty"),
        default_value=default,
    )
```

Check `PropertyType` members in `app/domain/entities/property.py:35-53` and confirm `TEXT` is the relation-text type (it is — text properties are stored as node references). If a type like `URL`/`EMAIL`/`DATE_RANGE` exists and should accept text defaults, map them to `default_text` in `_TYPE_DEFAULT_COLUMN` as well (read the enum and add all text-like members).

- [ ] **Step 5: Run test to verify it passes**

Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/unit/test_property_attributes_resolution.py -x --no-cov`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add app/domain/entities/property.py app/features/properties/attributes.py tests/unit/test_property_attributes_resolution.py
git commit -m "feat(properties): attribute entities and resolution module"
```

---

### Task 3: Repository — mapping, defaults persistence, edge lookup

**Files:**
- Modify: `app/features/properties/repository.py` — `_row_to_property`, `_row_to_class_property` (find via grep; they build the dataclasses from rows), `add_class_property` (line 1529-1563), `update_class_property` (line 1573-1606), new `get_class_property_edges_for_node`
- Test: `tests/test_property_attributes.py` (append)

**Interfaces:**
- Consumes: `attributes.default_columns_for_value` (Task 2)
- Produces:
  - `PropertyRepository.add_class_property(class_node_id, property_id, sequence=0, default_value=None, required=None, hidden=None, readonly=None, hide_when_empty=None, prop_type: PropertyType | None = None) -> ClassProperty` — persists typed default columns (no more `del default_value`)
  - `PropertyRepository.update_class_property(class_node_id, property_id, **updates) -> ClassProperty | None` — `updates` may include `required`, `hidden`, `readonly`, `hide_when_empty` (any bool or None, set verbatim including NULL) and `default_columns: dict[str, Any] | None` (sets given typed columns; a `clear_defaults: bool` flag NULLs all six)
  - `PropertyRepository.get_class_property_edges_for_node(node_id: int, property_id: int) -> list[ClassProperty]` — edges through which the property reaches the node, ordered nearest-first (depth, then position in `node.class_ids`)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_property_attributes.py`:

```python
@pytest.mark.asyncio
async def test_class_property_default_persists_on_add(auth_client: AsyncClient):
    """POST /classes/{uuid}/properties must persist default_value (was silently dropped)."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "DefaultedStatus", "type": "selection", "scope": "global",
        "selection_lines": ["Alpha", "Beta"],
    })
    assert prop_resp.status_code == 200, prop_resp.text
    prop = prop_resp.json()
    option_uuid = prop["options"][0]["selection_line_uuid"]

    # Any existing class works; use the page system class via a class listing
    classes_resp = await auth_client.get("/api/nodes/?pages_only=false&root_only=false")
    # Simpler: create a fresh class node
    class_resp = await auth_client.post("/api/nodes/", json={
        "name": "Test Class", "is_class": True,
    })
    assert class_resp.status_code == 200, class_resp.text
    class_uuid = class_resp.json()["uuid"]

    add_resp = await auth_client.post(
        f"/api/properties/classes/{class_uuid}/properties",
        json={"property_uuid": prop["property_uuid"], "default_value": option_uuid},
    )
    assert add_resp.status_code == 200, add_resp.text
    assert add_resp.json()["default_value"] == option_uuid


@pytest.mark.asyncio
async def test_class_property_patch_tri_state_and_default(auth_client: AsyncClient):
    """PATCH persists tri-state overrides and default_value (was silently ignored)."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "TriStateProp", "type": "boolean", "scope": "global",
    })
    prop_uuid = prop_resp.json()["property_uuid"]
    class_resp = await auth_client.post("/api/nodes/", json={
        "name": "TriState Class", "is_class": True,
    })
    class_uuid = class_resp.json()["uuid"]
    await auth_client.post(
        f"/api/properties/classes/{class_uuid}/properties",
        json={"property_uuid": prop_uuid},
    )
    url = f"/api/properties/classes/{class_uuid}/properties/{prop_uuid}"

    # force on
    r = await auth_client.patch(url, json={"required": True, "readonly": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["required"] is True and body["readonly"] is True
    assert body["hide_when_empty"] is None  # untouched -> inherit

    # force off + default
    r = await auth_client.patch(url, json={"required": False, "default_value": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["required"] is False and body["default_value"] is True

    # back to inherit (explicit null) — requires model_fields_set handling
    r = await auth_client.patch(url, json={"required": None})
    assert r.status_code == 200, r.text
    assert r.json()["required"] is None
```

Note: `default_value` responses carry the *public* form for selection/node defaults (UUID) — check `_class_property_default_value` usage in `router/classes.py:46-55` and Task 4's response mapping; if the response returns the internal id for selection defaults, the response mapper must translate `default_selection_id` → line UUID and `default_node_id` → node UUID (part of Task 4). Write the assertion to match the chosen contract (UUID in responses) and make Task 4 implement it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/test_property_attributes.py -x --no-cov -k "class_property"`
Expected: FAIL — `readonly` field rejected/ignored, `default_value` dropped, `required: None` rejected by the bool-typed request model.

- [ ] **Step 3: Fix row mapping**

In `app/features/properties/repository.py`, find `_row_to_property` and `_row_to_class_property` (grep `def _row_to_property` / `def _row_to_class_property`). Add the new columns to both mappings:

```python
# _row_to_property: add
        required=row.get("required", False) or False,
        readonly=row.get("readonly", False) or False,
        hide_when_empty=row.get("hide_when_empty", False) or False,
        default_integer=row.get("default_integer"),
        default_float=row.get("default_float"),
        default_text=row.get("default_text"),
        default_boolean=row.get("default_boolean"),
        default_node_id=row.get("default_node_id"),
        default_selection_id=row.get("default_selection_id"),

# _row_to_class_property: change required= to pass through NULL, add:
        required=row.get("required"),           # tri-state: may be None
        readonly=row.get("readonly"),
        hide_when_empty=row.get("hide_when_empty"),
```

If the mappings select explicit columns rather than `SELECT *`, add the new columns to those SELECT lists too (grep for the queries feeding these mappers; `add_class_property`/`update_class_property` use `RETURNING *` so they are covered).

- [ ] **Step 4: Rewrite add_class_property / update_class_property**

Replace `add_class_property` (repository.py:1529-1563) — remove `del default_value`, accept the new params, and build typed default columns via `default_columns_for_value`:

```python
    async def add_class_property(
        self,
        class_node_id: int,
        property_id: int,
        sequence: int = 0,
        default_value: Any = None,
        required: bool | None = None,
        hidden: bool | None = None,
        readonly: bool | None = None,
        hide_when_empty: bool | None = None,
        prop_type: PropertyType | None = None,
    ) -> ClassProperty:
        """Link a property to a class, persisting overrides and defaults."""
        from app.features.properties.attributes import default_columns_for_value

        columns = ["class_node_id", "property_id", "sequence"]
        values: list[Any] = [class_node_id, property_id, sequence]
        for col, val in (("required", required), ("hidden", hidden),
                         ("readonly", readonly), ("hide_when_empty", hide_when_empty)):
            if val is not None:
                columns.append(col)
                values.append(val)
        if prop_type is not None:
            for col, val in default_columns_for_value(prop_type, default_value).items():
                columns.append(col)
                values.append(val)

        col_sql = ", ".join(columns)
        placeholders = ", ".join(f"${i + 1}" for i in range(len(values)))
        updates = [f"{col} = ${i + 1}" for i, col in enumerate(columns)]
        sql = f"""
            INSERT INTO class_property ({col_sql})
            VALUES ({placeholders})
            ON CONFLICT (class_node_id, property_id) DO UPDATE SET {", ".join(updates)}
            RETURNING *
        """
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(sql, *values)
            if row is None:
                raise RuntimeError("Failed to add class property - no row returned")
            return self._row_to_class_property(row)
```

Replace `update_class_property` (repository.py:1573-1606) with a generic version:

```python
    async def update_class_property(
        self,
        class_node_id: int,
        property_id: int,
        *,
        clear_defaults: bool = False,
        default_columns: dict[str, Any] | None = None,
        **updates: Any,
    ) -> ClassProperty | None:
        """Update a class_property row. `updates` are set verbatim (including
        NULL — callers use this for tri-state 'inherit')."""
        from app.features.properties.attributes import DEFAULT_COLUMNS

        allowed = {"required", "hidden", "readonly", "hide_when_empty"}
        set_values: dict[str, Any] = {k: v for k, v in updates.items() if k in allowed}
        if clear_defaults:
            set_values.update({col: None for col in DEFAULT_COLUMNS})
        if default_columns:
            set_values.update(default_columns)

        async with acquire_connection(self._pool) as conn:
            if set_values:
                params = list(set_values.values()) + [class_node_id, property_id]
                set_clause = ", ".join(
                    f"{col} = ${i + 1}" for i, col in enumerate(set_values)
                )
                row = await conn.fetchrow(
                    f"UPDATE class_property SET {set_clause} "
                    f"WHERE class_node_id = ${len(params) - 1} AND property_id = ${len(params)} "
                    f"RETURNING *",
                    *params,
                )
            else:
                row = await conn.fetchrow(
                    "SELECT * FROM class_property WHERE class_node_id = $1 AND property_id = $2",
                    class_node_id, property_id,
                )
            return self._row_to_class_property(row) if row else None
```

- [ ] **Step 5: Add the edge lookup**

Add to `PropertyRepository` (uses `class_extend` where `target_id` = child class, `source_id` = parent class — same direction as `get_all_inherited_properties` at repository.py:1608-1619):

```python
    async def get_class_property_edges_for_node(
        self, node_id: int, property_id: int
    ) -> list[ClassProperty]:
        """Class_property edges connecting *property_id* to *node_id*'s class
        closure, ordered nearest-first (depth, then class_ids position)."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                WITH RECURSIVE closure AS (
                    SELECT u.class_id, 0 AS depth, u.ord
                    FROM node n,
                         unnest(n.class_ids) WITH ORDINALITY AS u(class_id, ord)
                    WHERE n.id = $1
                    UNION ALL
                    SELECT ce.source_id, c.depth + 1, c.ord
                    FROM closure c
                    JOIN class_extend ce ON ce.target_id = c.class_id
                    WHERE c.depth < 20
                ),
                best AS (
                    SELECT DISTINCT ON (class_id) class_id, depth, ord
                    FROM closure ORDER BY class_id, depth, ord
                )
                SELECT cp.*
                FROM class_property cp
                JOIN best b ON b.class_id = cp.class_node_id
                WHERE cp.property_id = $2
                ORDER BY b.depth, b.ord
                """,
                node_id,
                property_id,
            )
            return [self._row_to_class_property(r) for r in rows]
```

- [ ] **Step 6: Run tests**

The API-level tests also need Tasks 4's request/response model changes — if they still fail on model validation, mark expected and move on; rerun after Task 4. The repository behavior itself is verifiable via the existing test suite (nothing may regress):
Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/ -m "not slow" --no-cov -q`
Expected: no regressions (the two new tests may still fail on API wiring until Task 4)

- [ ] **Step 7: Commit**

```bash
git add app/features/properties/repository.py tests/test_property_attributes.py
git commit -m "feat(properties): persist class-property defaults and tri-state overrides in repository"
```

---

### Task 4: API models + endpoints

**Files:**
- Modify: `app/features/properties/models.py` (`PropertyResponse` :17-42, `PropertyUpdateRequest` :214-221, `ClassPropertyResponse` :161-176, `ClassPropertyRequest` :270-277, `ClassPropertyUpdateRequest` :280-285)
- Modify: `app/features/properties/router/classes.py` (`_class_property_default_value` :46-55, `_class_property_to_response` :120-140, add/patch endpoints :167-239)
- Modify: `app/features/properties/router/crud.py` (`update_property` :228-252)
- Modify: `app/features/properties/service.py` (`update_property` — grep `def update_property`; `update_class_property` :826-844; `add_class_property` — grep)
- Modify: property repository update method (grep `async def update_property` in repository.py)
- Test: `tests/test_property_attributes.py` (append)

**Interfaces:**
- Consumes: repository methods from Task 3, `attributes.default_columns_for_value`, `attributes.default_value_from_columns` (Task 2)
- Produces (API contract):
  - `PropertyResponse` gains `required: bool`, `readonly: bool`, `hide_when_empty: bool`, `default_value: Any | None` (selection/node defaults exposed as UUIDs)
  - `PropertyUpdateRequest` gains `required: bool | None`, `readonly: bool | None`, `hide_when_empty: bool | None`, `default_value: Any | None` (absent = no change; explicit null = clear all defaults; selection/node defaults given as UUIDs)
  - `ClassPropertyResponse`: `required: bool | None`, `readonly: bool | None`, `hide_when_empty: bool | None`, `default_value` exposes UUIDs for selection/node
  - `ClassPropertyRequest` / `ClassPropertyUpdateRequest` gain `readonly: bool | None`, `hide_when_empty: bool | None`; `ClassPropertyUpdateRequest.required` stays `bool | None` but explicit null is honored via `model_fields_set`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_property_attributes.py`:

```python
@pytest.mark.asyncio
async def test_property_attributes_roundtrip(auth_client: AsyncClient):
    """PUT /api/properties/{uuid} persists attribute bases and typed default."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "AttrProp", "type": "selection", "scope": "global",
        "selection_lines": ["One", "Two"],
    })
    prop = prop_resp.json()
    assert prop["required"] is False
    assert prop["readonly"] is False
    assert prop["hide_when_empty"] is False
    assert prop["default_value"] is None
    option_uuid = prop["options"][1]["selection_line_uuid"]

    put_resp = await auth_client.put(
        f"/api/properties/{prop['property_uuid']}",
        json={"required": True, "hide_when_empty": True, "default_value": option_uuid},
    )
    assert put_resp.status_code == 200, put_resp.text
    body = put_resp.json()
    assert body["required"] is True
    assert body["hide_when_empty"] is True
    assert body["readonly"] is False
    assert body["default_value"] == option_uuid

    # GET returns the same
    get_resp = await auth_client.get(f"/api/properties/uuid/{prop['property_uuid']}")
    assert get_resp.json()["default_value"] == option_uuid

    # explicit null clears the default
    clear_resp = await auth_client.put(
        f"/api/properties/{prop['property_uuid']}", json={"default_value": None},
    )
    assert clear_resp.json()["default_value"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/test_property_attributes.py -x --no-cov -k "roundtrip"`
Expected: FAIL — response model has no attribute fields.

- [ ] **Step 3: Extend the models**

In `app/features/properties/models.py`:

```python
# PropertyResponse — add:
    required: bool = False
    readonly: bool = False
    hide_when_empty: bool = False
    default_value: Any | None = None

# PropertyUpdateRequest — add:
    required: bool | None = None
    readonly: bool | None = None
    hide_when_empty: bool | None = None
    default_value: Any | None = None

# ClassPropertyResponse — change required and add:
    required: bool | None = None  # tri-state: None = inherit from property
    readonly: bool | None = None
    hide_when_empty: bool | None = None

# ClassPropertyRequest — change required and add:
    required: bool | None = None
    readonly: bool | None = None
    hide_when_empty: bool | None = None

# ClassPropertyUpdateRequest — add:
    readonly: bool | None = None
    hide_when_empty: bool | None = None
```

- [ ] **Step 4: Wire property update (service + repository + router)**

In `app/features/properties/service.py`, find `update_property` (grep `async def update_property`) and extend its signature with `required: bool | None = None, readonly: bool | None = None, hide_when_empty: bool | None = None, default_value: Any = _UNSET` where `_UNSET` is a module-level sentinel (`_UNSET = object()`). Pass through to the repository; convert `default_value` with `default_columns_for_value(prop.type, value)` — selection/node UUIDs must be resolved to internal ids first (reuse the resolve logic in `resolve_property_value`); explicit `None` → `clear_defaults=True`.

Extend the repository's property `update` method the same way (verbatim sets for the three flags; `default_columns` dict and `clear_defaults` flag like Task 3's class-property version).

In `app/features/properties/router/crud.py:228-252`, pass the new fields, using `model_fields_set` for default semantics:

```python
        default_provided = "default_value" in request.model_fields_set
        prop = await service.update_property(
            property_id,
            name=request.name,
            icon=request.icon,
            icon_visibility=request.icon_visibility,
            is_multi=request.multi,
            validation_rules=request.validation_rules,
            required=request.required,
            readonly=request.readonly,
            hide_when_empty=request.hide_when_empty,
            default_value=request.default_value if default_provided else _UNSET,
        )
```

(`_UNSET` imported from the service module.)

- [ ] **Step 5: Wire class-property add/patch and response mapping**

In `app/features/properties/router/classes.py`:

1. Replace `_class_property_default_value` (:46-55) with a UUID-aware version, and add the same for `Property`:

```python
async def _default_value_response(obj, prop_type: str, service, node_repo) -> Any:
    """Public form of the first non-None typed default column."""
    from app.features.properties.attributes import default_value_from_columns
    value = default_value_from_columns(obj)
    if value is None:
        return None
    if prop_type == "selection":
        line = await service._property_repo.get_selection_line_by_id(value)
        return str(line.uuid) if line else None
    if prop_type in ("node", "text", "date", "image"):
        node = await node_repo.get_by_id(value)
        return str(node.uuid) if node else None
    return value
```

(Check the repository for an existing `get_selection_line_by_id`; if absent add it next to `get_selection_line_by_uuid`. For text/date relation types the default columns store node ids; resolve via `node_repo.get_by_id` — verify the method name exists on the node repository port.)

2. `_class_property_to_response` (:120-140) becomes async-aware of the new mapper and passes `required=cp.required` (now nullable), `readonly=cp.readonly`, `hide_when_empty=cp.hide_when_empty`, `default_value=await _default_value_response(cp, prop.type.value, service, node_repo)` — thread `service`/`node_repo` into the function (its three call sites in this file all have both in scope).

3. `add_class_property` endpoint (:167-197): pass `readonly=request.readonly, hide_when_empty=request.hide_when_empty` through `service.add_class_property`, which must accept and forward them plus `default_value` and `prop_type=prop.type` to the repository (Task 3 signature). Selection/node default UUIDs are resolved to internal ids in the service before calling the repository.

4. `update_class_property` endpoint (:216-239): build verbatim updates from `request.model_fields_set`:

```python
    updates: dict[str, Any] = {}
    for field in ("required", "hidden", "readonly", "hide_when_empty"):
        if field in request.model_fields_set:
            updates[field] = getattr(request, field)
    default_provided = "default_value" in request.model_fields_set
    result = await service.update_class_property(
        class_node_id,
        property_id,
        updates=updates,
        default_value=request.default_value if default_provided else _UNSET,
    )
```

(`_UNSET` imported from `app.features.properties.service`, same as in the crud.py change above.)

Extend `service.update_class_property` (:826-844) to accept `updates: dict` and `default_value` (sentinel), resolving selection/node UUIDs and calling the Task-3 repository method (`clear_defaults=True` when `default_value is None` and provided).

5. The property GET response path: find `_property_to_response` (used by crud.py endpoints) and add `required=prop.required, readonly=prop.readonly, hide_when_empty=prop.hide_when_empty, default_value=await _default_value_response(prop, prop.type.value, service, node_repo)` — thread through whatever maps it needs (check its current signature and call sites; it likely already has `node_repo` maps).

- [ ] **Step 6: Run all property-attribute tests**

Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/test_property_attributes.py tests/unit/test_property_attributes_resolution.py -x --no-cov`
Expected: PASS (all)

- [ ] **Step 7: Regression sweep + commit**

Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/ -m "not slow" --no-cov -q` and `docker compose -f compose.dev.yaml exec -T backend uv run ruff check app/`
Expected: no failures, no lint errors

```bash
git add app/features/properties/models.py app/features/properties/router/classes.py app/features/properties/router/crud.py app/features/properties/service.py app/features/properties/repository.py tests/test_property_attributes.py
git commit -m "feat(properties): expose attribute bases and tri-state overrides via API"
```

---

### Task 5: Enforcement — required, readonly, default-or-reject

**Files:**
- Modify: `app/features/properties/service.py` (`set_property_value` :543-655, `set_property_value_by_uuid` :521-541)
- Modify: `app/features/properties/router/values.py` (error mapping :159-165; the typed endpoints :314-570 route through the same service)
- Modify: `app/features/tasks/service.py` (automation writes — grep `set_property_value` in that file; pass the bypass)
- Test: `tests/test_property_attributes.py` (append)

**Interfaces:**
- Consumes: `resolve_attributes`, `is_empty_value`, `RequiredPropertyError`, `ReadonlyPropertyError` (Task 2); `get_class_property_edges_for_node` (Task 3)
- Produces:
  - `PropertyService.set_property_value(node_id, property_id, value, *, run_automations=True, log_activity=True, enforce_attributes=True) -> None` — same for `set_property_value_by_uuid`
  - Behavior: readonly (effective) + `enforce_attributes` → `ReadonlyPropertyError`; empty value + required (effective) + `enforce_attributes` → default-or-reject (reset to effective default when available, else `RequiredPropertyError`)
  - Automations call with `enforce_attributes=False`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_property_attributes.py`:

```python
@pytest.mark.asyncio
async def test_required_clear_resets_to_default(auth_client: AsyncClient):
    """Clearing an effective-required property with a default resets to default."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "ReqSel", "type": "selection", "scope": "global",
        "selection_lines": ["Open", "Shut"],
    })
    prop = prop_resp.json()
    prop_uuid = prop["property_uuid"]
    open_uuid = prop["options"][0]["selection_line_uuid"]
    shut_uuid = prop["options"][1]["selection_line_uuid"]
    await auth_client.put(f"/api/properties/{prop_uuid}",
                          json={"required": True, "default_value": open_uuid})

    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "N"})).json()["uuid"]
    await auth_client.post(f"/api/nodes/{node_uuid}/properties",
                           json={"property_uuid": prop_uuid, "value": shut_uuid})

    # clear -> resets to default (200, not an error)
    r = await auth_client.post(f"/api/nodes/{node_uuid}/properties",
                               json={"property_uuid": prop_uuid, "value": None})
    assert r.status_code == 200, r.text
    content = (await auth_client.get(f"/api/nodes/page/{node_uuid}/content")).json()
    assert content["properties_uuid"][prop_uuid] == open_uuid


@pytest.mark.asyncio
async def test_required_clear_without_default_rejected(auth_client: AsyncClient):
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "ReqNoDefault", "type": "selection", "scope": "global",
        "selection_lines": ["A", "B"],
    })
    prop_uuid = prop_resp.json()["property_uuid"]
    a_uuid = prop_resp.json()["options"][0]["selection_line_uuid"]
    await auth_client.put(f"/api/properties/{prop_uuid}", json={"required": True})

    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "N2"})).json()["uuid"]
    await auth_client.post(f"/api/nodes/{node_uuid}/properties",
                           json={"property_uuid": prop_uuid, "value": a_uuid})
    r = await auth_client.post(f"/api/nodes/{node_uuid}/properties",
                               json={"property_uuid": prop_uuid, "value": None})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "required_property"
    # value untouched
    content = (await auth_client.get(f"/api/nodes/page/{node_uuid}/content")).json()
    assert content["properties_uuid"][prop_uuid] == a_uuid


@pytest.mark.asyncio
async def test_readonly_rejects_writes(auth_client: AsyncClient):
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "Locked", "type": "boolean", "scope": "global",
    })
    prop_uuid = prop_resp.json()["property_uuid"]
    await auth_client.put(f"/api/properties/{prop_uuid}", json={"readonly": True})
    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "N3"})).json()["uuid"]
    r = await auth_client.post(f"/api/nodes/{node_uuid}/properties",
                               json={"property_uuid": prop_uuid, "value": True})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "readonly_property"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/test_property_attributes.py -x --no-cov -k "required_clear or readonly"`
Expected: FAIL — clears succeed silently, no error codes.

- [ ] **Step 3: Add enforcement to set_property_value**

In `app/features/properties/service.py`, extend `set_property_value` and `set_property_value_by_uuid` with `enforce_attributes: bool = True` (forwarded). Insert after the `prop` load in `set_property_value` (after line 560), before the type dispatch:

```python
        if enforce_attributes:
            from app.features.properties.attributes import (
                ReadonlyPropertyError,
                RequiredPropertyError,
                is_empty_value,
                resolve_attributes,
            )

            edges = await self._property_repo.get_class_property_edges_for_node(
                node_id, property_id
            )
            effective = resolve_attributes(prop, edges)
            if effective.readonly:
                raise ReadonlyPropertyError(
                    f"Property '{prop.name}' is read-only for this node"
                )
            if effective.required and is_empty_value(value):
                if effective.default_value is not None:
                    value = effective.default_value
                else:
                    raise RequiredPropertyError(
                        f"Property '{prop.name}' is required for this node"
                    )
```

Notes for the implementer:
- The default rewrite must run task automations with the *defaulted* value — the rewrite happens before dispatch, so `_run_task_automations` (line 651-652) already sees it.
- Scalar types: `set_scalar_value` with an empty string currently stores an empty string — for required scalar properties the rewrite/reject must also apply when `value == ""` (covered: `is_empty_value` catches it before dispatch).

- [ ] **Step 4: Map the errors in the values router**

In `app/features/properties/router/values.py`, find the `except ValueError` mapping around :159-165 and add before it:

```python
    except (RequiredPropertyError, ReadonlyPropertyError) as e:
        raise HTTPException(status_code=400, detail={"code": e.code, "message": str(e)}) from e
```

Import the exceptions from `app.features.properties.attributes`. Apply the same mapping in the typed value endpoints (`/scalar`, `/relation`, `/selection` POST handlers in the same file) and the batch endpoint (`values.py:603-661`) — everywhere `set_property_value*` is called.

- [ ] **Step 5: Bypass for automations**

Grep `app/features/tasks/service.py` for `set_property_value` calls (status reset on recurrence ~:113-193, closed-date set/clear ~:89-111) and add `enforce_attributes=False` to each. If automations write via the repository directly, no change is needed there — note it in the commit message.

- [ ] **Step 6: Run tests**

Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/test_property_attributes.py tests/unit/test_property_attributes_resolution.py -x --no-cov`
Expected: PASS (all)

- [ ] **Step 7: Regression sweep + commit**

Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/ -m "not slow" --no-cov -q` and `docker compose -f compose.dev.yaml exec -T backend uv run ruff check app/`
Expected: no failures (sync path: `RequiredPropertyError`/`ReadonlyPropertyError` subclass `ValueError`, so `service_v2.py:462` skips violating ops — no change needed there)

```bash
git add app/features/properties/service.py app/features/properties/router/values.py app/features/tasks/service.py tests/test_property_attributes.py
git commit -m "feat(properties): enforce required/readonly with default-or-reject semantics"
```

---

### Task 6: Property-level defaults on class assignment

**Files:**
- Modify: `app/features/nodes/class_management_service.py` (`_apply_class_property_defaults` :305-352)
- Test: `tests/test_property_attributes.py` (append)

**Interfaces:**
- Consumes: `attributes.default_value_from_columns` (Task 2)
- Produces: `_apply_class_property_defaults` falls back to the property's own default columns when the class edge declares none.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_property_attributes.py`:

```python
@pytest.mark.asyncio
async def test_class_assignment_applies_property_level_default(auth_client: AsyncClient):
    """A class edge without its own default inherits the property-level default."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "DefaultedBool", "type": "boolean", "scope": "global",
    })
    prop_uuid = prop_resp.json()["property_uuid"]
    await auth_client.put(f"/api/properties/{prop_uuid}", json={"default_value": True})

    class_uuid = (await auth_client.post(
        "/api/nodes/", json={"name": "Default Class", "is_class": True}
    )).json()["uuid"]
    await auth_client.post(f"/api/properties/classes/{class_uuid}/properties",
                           json={"property_uuid": prop_uuid})

    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "DN"})).json()["uuid"]
    add_resp = await auth_client.post(f"/api/nodes/{node_uuid}/classes",
                                      json={"class_uuid": class_uuid})
    assert add_resp.status_code == 200, add_resp.text

    content = (await auth_client.get(f"/api/nodes/page/{node_uuid}/content")).json()
    assert content["properties_uuid"][prop_uuid] is True
```

(Check the add-class endpoint path/body against an existing test — grep `tests/` for `/classes` on nodes, e.g. `tests/test_tasks.py` or `tests/test_system_types.py`, and match its contract.)

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/test_property_attributes.py -x --no-cov -k "property_level_default"`
Expected: FAIL — no value applied.

- [ ] **Step 3: Add the fallback**

In `app/features/nodes/class_management_service.py:_apply_class_property_defaults` (:305-352), replace the per-type `cp.default_*` reads with a two-level lookup. Import `default_value_from_columns` from `app.features.properties.attributes` and change each branch's default source from `cp` to "edge first, then property":

```python
            try:
                default = default_value_from_columns(cp)
                if default is None:
                    default = default_value_from_columns(prop)
                if default is None:
                    continue

                if prop.type in SCALAR_TYPES:
                    if prop.type in (PropertyType.INTEGER, PropertyType.FLOAT, PropertyType.BOOLEAN):
                        await self._property_repo.set_scalar_value(node_id, cp.property_id, default)

                elif prop.type in RELATION_TYPES:
                    if prop.type == PropertyType.NODE:
                        await self._property_repo.set_relation_value(node_id, cp.property_id, default)
                    elif prop.type == PropertyType.TEXT:
                        text_node = await self._node_repo.create(
                            NodeCreateData(
                                name=serialize_ast(parse_ast(str(default), ParseMode.PLAIN)),
                                parent_id=node_id,
                            ),
                            None,
                        )
                        await self._property_repo.set_relation_value(node_id, cp.property_id, text_node.id)

                elif prop.type == PropertyType.SELECTION:
                    await self._property_repo.set_selection_value(node_id, cp.property_id, default)

            except Exception as exc:
                logger.warning(f"Failed to set default value for property {cp.property_id} on node {node_id}: {exc}")
```

Keep the existing "skip properties that already have values" guard (:319-321) unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/test_property_attributes.py -x --no-cov`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add app/features/nodes/class_management_service.py tests/test_property_attributes.py
git commit -m "feat(properties): apply property-level defaults on class assignment"
```

---

### Task 7: Seed + backfill — task Status required with Pending default

**Files:**
- Modify: `app/db/schema/init.py` (task-status seeding :1344-1387)
- Modify: `app/db/schema/sql.py` (append migration blocks)
- Test: `tests/test_property_attributes.py` (append)

**Interfaces:**
- Consumes: `SYSTEM_PROPERTY_UUIDS["task_status"]` and `TASK_DEFAULT_STATUS` from `app/domain/entities/constants.py:180-215` (read the exact UUID string there)
- Produces: on every workspace (fresh or upgraded), the system task-status property has `required=true` and `default_selection_id` = its Pending line; task nodes lacking a Status value receive Pending.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_property_attributes.py`:

```python
@pytest.mark.asyncio
async def test_system_task_status_is_required_with_pending_default(auth_client: AsyncClient):
    """The seeded task-status property carries required + Pending default."""
    from app.domain.entities.constants import SYSTEM_PROPERTY_UUIDS

    resp = await auth_client.get(
        f"/api/properties/uuid/{SYSTEM_PROPERTY_UUIDS['task_status']}"
    )
    assert resp.status_code == 200, resp.text
    prop = resp.json()
    assert prop["required"] is True
    pending = next(
        (o for o in prop["options"] if o["name"] == "Pending"), None
    )
    assert pending is not None
    assert prop["default_value"] == pending["selection_line_uuid"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/test_property_attributes.py -x --no-cov -k "system_task_status"`
Expected: FAIL — `required` is false.

- [ ] **Step 3: Update the seed**

In `app/db/schema/init.py`, at the end of the task-status seeding block (:1344-1387, after the Pending option id is known and the class link is created), add:

```python
        # Task status is required at property level; Pending is the base default.
        await conn.execute(
            """
            UPDATE property
            SET required = TRUE, default_selection_id = $1
            WHERE uuid = $2
            """,
            pending_line_id,
            SYSTEM_PROPERTY_UUIDS["task_status"],
        )
```

Match the surrounding code's connection/variable names exactly (read the block first; the class-edge `default_selection_id` link at :1378-1387 stays — it now acts as a redundant override).

- [ ] **Step 4: Append the upgrade migration + backfill**

Append to `app/db/schema/sql.py`:

```sql
-- Migration: system task-status property is required with Pending default.
-- Also backfills task nodes that have no Status value.
DO $$
DECLARE
    status_prop_id BIGINT;
    pending_line_id BIGINT;
BEGIN
    SELECT id INTO status_prop_id FROM property
    WHERE uuid = '00000003-0000-0000-0001-000000000001';  -- verify against SYSTEM_PROPERTY_UUIDS['task_status'] in app/domain/entities/constants.py
    IF status_prop_id IS NULL THEN
        RETURN;
    END IF;

    SELECT id INTO pending_line_id FROM property_selection_line
    WHERE property_id = status_prop_id AND name = 'Pending'
    ORDER BY sequence LIMIT 1;
    IF pending_line_id IS NULL THEN
        RETURN;
    END IF;

    UPDATE property
    SET required = TRUE, default_selection_id = pending_line_id
    WHERE id = status_prop_id AND (required IS DISTINCT FROM TRUE OR default_selection_id IS NULL);

    -- Backfill: every task node without a status value gets Pending.
    INSERT INTO property_value_selection (node_property_id, selection_line_id, sequence)
    SELECT np.id, pending_line_id, 0
    FROM node n
    JOIN node_property np ON np.node_id = n.id AND np.property_id = status_prop_id
    WHERE n.is_task = TRUE
      AND n.active = TRUE
      AND n.is_deleted = FALSE
      AND NOT EXISTS (
          SELECT 1 FROM property_value_selection pvs WHERE pvs.node_property_id = np.id
      );

    -- Task nodes with no node_property assignment at all: create the
    -- assignment first, then the value.
    INSERT INTO node_property (node_id, property_id)
    SELECT n.id, status_prop_id
    FROM node n
    WHERE n.is_task = TRUE AND n.active = TRUE AND n.is_deleted = FALSE
      AND NOT EXISTS (
          SELECT 1 FROM node_property np2
          WHERE np2.node_id = n.id AND np2.property_id = status_prop_id
      );

    INSERT INTO property_value_selection (node_property_id, selection_line_id, sequence)
    SELECT np.id, pending_line_id, 0
    FROM node n
    JOIN node_property np ON np.node_id = n.id AND np.property_id = status_prop_id
    WHERE n.is_task = TRUE AND n.active = TRUE AND n.is_deleted = FALSE
      AND NOT EXISTS (
          SELECT 1 FROM property_value_selection pvs WHERE pvs.node_property_id = np.id
      );
END $$;
```

(Verify the `node_property` and `property_value_selection` column names against the table definitions at `app/db/schema/sql.py:476-486` and :561-572 before finalizing the INSERTs.)

- [ ] **Step 5: Run tests**

Restart backend (migrations run at startup):
Run: `docker compose -f compose.dev.yaml restart backend && docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/test_property_attributes.py tests/unit/test_property_attributes_resolution.py -x --no-cov`
Expected: PASS (all)

- [ ] **Step 6: Regression sweep + commit**

Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/ -m "not slow" --no-cov -q`
Expected: no failures — existing task tests must still pass (status default now arrives via property base too)

```bash
git add app/db/schema/init.py app/db/schema/sql.py tests/test_property_attributes.py
git commit -m "feat(properties): require task status with Pending default, backfill missing statuses"
```

---

### Task 8: Frontend types + API client

**Files:**
- Modify: `frontend/src/types/api.ts` (`Property` interface; `ClassProperty` interface — grep `interface ClassProperty`)
- Modify: `frontend/src/api/properties.ts` (`updateProperty` :73; class-property functions :200-254)
- Test: covered by component tests in Tasks 9-11 (types only)

**Interfaces:**
- Produces:
  - `Property` gains `required: boolean`, `readonly: boolean`, `hide_when_empty: boolean`, `default_value: unknown | null`
  - `ClassProperty.required` becomes `boolean | null`; gains `readonly: boolean | null`, `hide_when_empty: boolean | null`
  - `propertiesApi.updateProperty(uuid, payload)` payload gains `required?: boolean`, `readonly?: boolean`, `hide_when_empty?: boolean`, `default_value?: unknown | null`
  - `propertiesApi.updateClassProperty(classUuid, propertyUuid, payload)` payload gains `required?: boolean | null`, `readonly?: boolean | null`, `hide_when_empty?: boolean | null`, `default_value?: unknown | null` — explicit `null` is sent verbatim (tri-state inherit)

- [ ] **Step 1: Extend the types**

In `frontend/src/types/api.ts`, add to `Property` (near the existing `icon_visibility` field):

```ts
  required: boolean;
  readonly: boolean;
  hide_when_empty: boolean;
  default_value: unknown | null;
```

Change `ClassProperty.required` to `boolean | null` and add:

```ts
  readonly: boolean | null;
  hide_when_empty: boolean | null;
```

- [ ] **Step 2: Extend the API payloads**

In `frontend/src/api/properties.ts`, extend the `updateProperty` payload type and the class-property update function (read the current signatures first — they use inline object types). No runtime logic changes: the payloads pass through verbatim.

- [ ] **Step 3: Type-check**

Run: `docker compose -f compose.dev.yaml exec -T frontend npx tsc -b --noEmit`
Expected: clean — downstream consumers of `ClassProperty.required` as `boolean` may error; fix them for tri-state (the only known consumer is `ClassPropertiesEditor.tsx:183-197`, rewritten in Task 11 — adjust it minimally now so tsc passes: treat `null` as `false` temporarily with a `// TODO(task-11)` comment)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types/api.ts frontend/src/api/properties.ts
git commit -m "feat(properties): frontend types and API payloads for property attributes"
```

---

### Task 9: Display — hide-when-empty, readonly, block-row empty properties

**Files:**
- Modify: `frontend/src/features/properties/components/PropertiesSection.tsx` (full file read in planning: bucketing :275-312, render :315-332, context menu :335-362)
- Modify: `frontend/src/features/content/components/blocks/BlockRow.tsx` (:613-629)
- Test: `frontend/src/features/properties/components/PropertiesSection.test.tsx` (extend), `frontend/src/features/content/components/blocks/BlockRow.test.tsx` (extend)

**Interfaces:**
- Consumes: `Property.required/readonly/hide_when_empty/default_value`, `ClassProperty.required/readonly/hide_when_empty` (Task 8)
- Produces: display behavior per spec Section 3 — no new exported interfaces.

Key facts for the implementer (from the current code):
- `PropertiesSection` builds `nodeProperties` entries from up to three class-property fetches (`useClassProperties(classUuid, true)`) plus node-valued properties; each entry has `{ property, value, source?, hidden? }` (:100-176).
- The visible/hidden split is at :275-312; `isMainNode` moves icon-visibility properties to the hidden bucket for non-main nodes.
- `BlockRow` renders `<PropertiesSection ... inline onlyWithValues isMainNode={false} showHiddenSection={false} />` (:616-629).

- [ ] **Step 1: Write the failing tests**

Extend `frontend/src/features/properties/components/PropertiesSection.test.tsx` (it already mocks `@/features/properties/hooks`, `@/features/content`, `@/plugins/builtin/flashcards`, `./PropertyValue` — reuse that scaffolding):

```tsx
it('moves empty hide-when-empty properties to the hidden bucket', async () => {
  // property base hide_when_empty=true, no value on node
  // → not in visible list; appears only in the hidden section
});

it('shows empty hide-when-empty property once it has a value', async () => {
  // same property with a value → visible
});

it('class-edge hide_when_empty override beats property base', async () => {
  // base false, edge true, empty → hidden; base true, edge false, empty → visible
});

it('renders readonly entries with disabled editors and no empty/remove actions', async () => {
  // PropertyValue receives readOnly; context menu lacks "Empty property"/"Remove from node"
});

it('hides "Empty property" for required entries without a default, keeps it with a default', async () => {
  // required + no default_value → no empty action; required + default_value → action present
});
```

(Write these against the existing test's mock style — the file already builds `Property`/`ClassProperty` fixtures and drives `useNode`/`useClassProperties` mock data. The PropertyList hidden section is rendered when `showHiddenSection` — for non-inline tests keep the default.)

Extend `frontend/src/features/content/components/blocks/BlockRow.test.tsx`:

```tsx
it('renders class-declared properties even when empty', async () => {
  // BlockRow with a classed node whose class declares a property with no value
  // → PropertiesSection receives no onlyWithValues filter and the empty row renders
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose -f compose.dev.yaml exec -T frontend npx vitest run src/features/properties/components/PropertiesSection.test.tsx src/features/content/components/blocks/BlockRow.test.tsx`
Expected: FAIL — hide-when-empty entries visible; readonly not honored.

- [ ] **Step 3: Compute effective attributes in PropertiesSection**

In `PropertiesSection.tsx`, when building entries (:110-139 for class properties), carry the edge through and compute effective attributes:

```tsx
    for (const classProp of allClassProperties) {
      // ...existing lookup of prop...
      const effectiveHideWhenEmpty = classProp.hide_when_empty ?? prop.hide_when_empty;
      const effectiveReadonly = classProp.readonly ?? prop.readonly;
      const effectiveRequired = classProp.required ?? prop.required;
      const hasValue = node?.properties_uuid
        && prop.uuid in (node.properties_uuid as Record<string, unknown>);
      entries.push({
        property: prop,
        value: hasValue
          ? (node!.properties_uuid as Record<string, unknown>)[prop.uuid]
          : classProp.default_value ?? prop.default_value ?? null,
        source: classProp.class_node_name || `Class #${classProp.class_node_uuid}`,
        hidden: (classProp.hidden ?? false) || (effectiveHideWhenEmpty && !hasValue),
        readOnly: effectiveReadonly,
        required: effectiveRequired,
        hasDefault: (classProp.default_value ?? prop.default_value) != null,
      });
    }
```

Extend the entry type (`Array<{ property; value; source?; hidden?; readOnly?; required?; hasDefault? }>`) and the `PropertyEntry` type in `PropertyList` if it is defined there (grep `PropertyEntry` in `PropertyList.tsx`) with the same optional fields. For the non-class branch (:143-165), compute the same from the property base alone (`prop.hide_when_empty && !hasValue`, `prop.readonly`, `prop.required`, `prop.default_value != null`).

Note on the first-occurrence-wins dedup (:112-113): entries are ordered by class fetch (class 1 → 3, each include-inherited). This approximates nearest-edge-wins; if `useClassProperties` returns inherited edges before direct ones, check the API ordering (`get_all_inherited_properties` orders by depth — direct first) and keep as-is.

- [ ] **Step 4: Wire readonly + required into rendering**

- `renderPropertyValue` (:315-332): pass `readOnly={isReadOnly || entry.readOnly || setPropertyMutation.isPending}`.
- `getPropertyContextMenuItems` (:335-362): when `entry.readOnly`, disable both `empty-property` and `remove-property` (look up the entry by `property.uuid` — build a `Map` from `nodeProperties`); hide `empty-property` when `entry.required && !entry.hasDefault`.
- No changes to the visible/hidden split itself — the `hidden` flag computed in Step 3 flows through the existing bucketing (:292-309).

- [ ] **Step 5: Drop onlyWithValues in BlockRow**

In `BlockRow.tsx:616-629`, remove the `onlyWithValues` prop from the `PropertiesSection` usage and update the comment (:613-615) to: "Inline properties: class-declared properties (even empty) and valued ad-hoc ones. Icon-visible properties stay as bullet/content icons; hidden and empty-hide-when-empty properties are omitted in rows."

Keep the `onlyWithValues` prop itself in `PropertiesSection` (still used by linked-references/embedding contexts — grep to confirm before removing any usage; if nothing else uses it, keep the prop but leave it unused-by-BlockRow).

- [ ] **Step 6: Run tests + type-check + lint**

Run: `docker compose -f compose.dev.yaml exec -T frontend npx vitest run src/features/properties/components/PropertiesSection.test.tsx src/features/content/components/blocks/BlockRow.test.tsx src/features/content/components/blocks/BlockList.focused.test.tsx`
Expected: PASS
Run: `docker compose -f compose.dev.yaml exec -T frontend npx tsc -b --noEmit` and `docker compose -f compose.dev.yaml exec -T frontend npm run lint`
Expected: clean (0 errors)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/properties/components/PropertiesSection.tsx frontend/src/features/properties/components/PropertyList.tsx frontend/src/features/content/components/blocks/BlockRow.tsx frontend/src/features/properties/components/PropertiesSection.test.tsx frontend/src/features/content/components/blocks/BlockRow.test.tsx
git commit -m "feat(properties): hide-when-empty bucketing, readonly rendering, empty class properties in block rows"
```

---

### Task 10: Property page attributes UI + shared DefaultValueEditor

**Files:**
- Create: `frontend/src/features/properties/components/DefaultValueEditor.tsx`
- Modify: `frontend/src/features/properties/components/PropertyConfigSection.tsx` (dead default stub :48 and :333; validation-rules section :399-480 is the style model)
- Modify: `frontend/src/features/properties/hooks/usePropertyMutations.ts` (`useUpdateProperty` :22-33 — payload type only, if needed)
- Test: `frontend/src/features/properties/components/DefaultValueEditor.test.tsx` (create)

**Interfaces:**
- Consumes: `propertiesApi.updateProperty` extended payload (Task 8)
- Produces:
  - `DefaultValueEditor` component: `function DefaultValueEditor({ property, value, onChange, className? }: { property: Property; value: unknown | null; onChange: (value: unknown | null) => void; className?: string })` — renders a type-appropriate editor for `text`/`url`/`email` (text input), `integer`/`float` (number input), `boolean` (select: unset/true/false), `selection` (dropdown of `property.options`, value = `selection_line_uuid`); for `node`/`date`/`image`/`date_range` renders a read-only note "Default not editable here" (API-only this round). `onChange(null)` means "no default".

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/properties/components/DefaultValueEditor.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DefaultValueEditor } from './DefaultValueEditor';
import type { Property } from '@/types/api';

function makeProp(overrides: Partial<Property>): Property {
  return {
    uuid: 'p1', name: 'P', type: 'text', multi: false, is_system: false,
    scope: 'global', icon: null, icon_visibility: null,
    required: false, readonly: false, hide_when_empty: false, default_value: null,
    ...overrides,
  } as Property;
}

describe('DefaultValueEditor', () => {
  it('edits a text default and clears it', () => {
    const onChange = vi.fn();
    render(<DefaultValueEditor property={makeProp({ type: 'text' })} value={null} onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalledWith('hello');
  });

  it('selects a selection option by uuid', () => {
    const onChange = vi.fn();
    render(
      <DefaultValueEditor
        property={makeProp({
          type: 'selection',
          options: [
            { selection_line_uuid: 'opt-1', name: 'One' },
            { selection_line_uuid: 'opt-2', name: 'Two' },
          ],
        } as Partial<Property>)}
        value={null}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'opt-2' } });
    expect(onChange).toHaveBeenCalledWith('opt-2');
  });

  it('boolean default supports unset/true/false', () => {
    const onChange = vi.fn();
    render(<DefaultValueEditor property={makeProp({ type: 'boolean' })} value={null} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'true' } });
    expect(onChange).toHaveBeenCalledWith(true);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('renders a note for relation types without editor support', () => {
    render(<DefaultValueEditor property={makeProp({ type: 'node' })} value={null} onChange={vi.fn()} />);
    expect(screen.getByText(/not editable/i)).toBeInTheDocument();
  });
});
```

(Match the exact `Property`/`SelectionLine` field names in `frontend/src/types/api.ts` — adjust `makeProp` and the options fixture to the real shapes; the test file for `PropertiesSection` has working fixture examples.)

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f compose.dev.yaml exec -T frontend npx vitest run src/features/properties/components/DefaultValueEditor.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement DefaultValueEditor**

Create `frontend/src/features/properties/components/DefaultValueEditor.tsx`. Follow the styling conventions of `PropertyConfigSection.tsx` (co-located CSS if needed — check how that file styles its controls and reuse class names/tokens from `variables.css`). Behavior per the interface above:
- text/url/email: `<input type="text">` (empty string → `onChange(null)`)
- integer/float: `<input type="number">` (parse; empty → null)
- boolean: `<select>` with `""` (unset → null), `"true"`, `"false"`
- selection: `<select>` with `""` (unset → null) + one `<option>` per `property.options` entry (value = line uuid)
- node/date/image/date_range: `<span>` note

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose -f compose.dev.yaml exec -T frontend npx vitest run src/features/properties/components/DefaultValueEditor.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Add the Attributes group to PropertyConfigSection**

Read `PropertyConfigSection.tsx` fully first. Then:
1. Delete the dead stub `const defaultValue = ''; // default_value not yet supported by backend` (:48) and the `onDefaultValueChange={() => {}}` (:333).
2. Add a new section (styled like `ValidationRulesSection` at :399-480) titled "Attributes" with three toggle rows (Required / Read-only / Hide when empty) bound to `property.required` / `property.readonly` / `property.hide_when_empty`, and a `<DefaultValueEditor property={property} value={property.default_value} onChange={...} />`.
3. Wire each control to `useUpdateProperty()` (`usePropertyMutations.ts:22-33`): `mutate({ uuid: property.uuid, ...{ required: !property.required } })` etc.; for the default: `mutate({ uuid: property.uuid, default_value: value })` — verify the mutation's payload type accepts the new fields (Task 8) and extend it if not. Check the mutation's `onSuccess` invalidates the property detail query (grep its invalidation logic; add `propertyKeys.detail(uuid)` invalidation if missing).

- [ ] **Step 6: Type-check + lint + full frontend tests**

Run: `docker compose -f compose.dev.yaml exec -T frontend npx tsc -b --noEmit && docker compose -f compose.dev.yaml exec -T frontend npm run lint && docker compose -f compose.dev.yaml exec -T frontend npm run test:run`
Expected: clean tsc, 0 lint errors, all tests pass

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/properties/components/DefaultValueEditor.tsx frontend/src/features/properties/components/DefaultValueEditor.test.tsx frontend/src/features/properties/components/PropertyConfigSection.tsx frontend/src/features/properties/hooks/usePropertyMutations.ts
git commit -m "feat(properties): attributes UI on property page with default value editor"
```

(Only stage `usePropertyMutations.ts` if changed.)

---

### Task 11: ClassPropertiesEditor — tri-state overrides + default override

**Files:**
- Modify: `frontend/src/features/properties/components/ClassPropertiesEditor.tsx` (required toggle :183-197; list rendering around :160-200)
- Modify: `frontend/src/features/properties/hooks/useClassPropertyMutations.ts` (`useUpdateClassProperty` :26-95 — payload type)
- Test: `frontend/src/features/properties/components/ClassPropertiesEditor.test.tsx` (create)

**Interfaces:**
- Consumes: `DefaultValueEditor` (Task 10), `propertiesApi.updateClassProperty` tri-state payload (Task 8)
- Produces:
  - `TriStateToggle` (local component in `ClassPropertiesEditor.tsx`): `function TriStateToggle({ value, baseValue, onChange, icons, labels }: { value: boolean | null; baseValue: boolean; onChange: (v: boolean | null) => void; icons: { on: string; off: string; inherit: string }; labels: { on: string; off: string; inherit: (base: boolean) => string } })` — click cycles inherit → on → off → inherit; title attribute shows the current state, and for inherit shows the resolved base (e.g. "Inherit (required)").

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/properties/components/ClassPropertiesEditor.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClassPropertiesEditor } from './ClassPropertiesEditor';

// Mock the class-property hooks (match their real return shapes from
// useClassPropertyMutations.ts and the query hooks used by the component).
const updateMutate = vi.fn();
vi.mock('../hooks', () => ({
  useClassProperties: () => ({
    data: [
      {
        class_property_uuid: 'cp-1',
        class_node_uuid: 'class-1',
        class_node_name: 'Task',
        property_uuid: 'prop-status',
        property_name: 'Status',
        property_type: 'selection',
        sequence: 0,
        default_value: null,
        hidden: false,
        required: null,
        readonly: null,
        hide_when_empty: null,
      },
    ],
  }),
  useUpdateClassProperty: () => ({ mutate: updateMutate }),
  useRemoveClassProperty: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/features/properties/hooks', () => ({
  useProperties: () => ({ data: [
    { uuid: 'prop-status', name: 'Status', type: 'selection',
      required: true, readonly: false, hide_when_empty: false,
      default_value: 'opt-pending', options: [] },
  ] }),
}));

function renderEditor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ClassPropertiesEditor classNodeUuid="class-1" />
    </QueryClientProvider>,
  );
}

describe('ClassPropertiesEditor tri-state overrides', () => {
  it('cycles required inherit -> on -> off -> inherit', () => {
    renderEditor();
    const btn = screen.getByTitle(/inherit \(required\)/i);
    fireEvent.click(btn);
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ required: true }),
      expect.anything(),
    );
    updateMutate.mockClear();
    fireEvent.click(btn);
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ required: false }),
      expect.anything(),
    );
    updateMutate.mockClear();
    fireEvent.click(btn);
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ required: null }),
      expect.anything(),
    );
  });

  it('shows the resolved base in inherit state', () => {
    renderEditor();
    // property base required=true, edge=null -> inherit (required)
    expect(screen.getByTitle(/inherit \(required\)/i)).toBeInTheDocument();
  });
});
```

Read `ClassPropertiesEditor.tsx` before finalizing this test: match its real props (the `classNodeUuid` prop name is a guess — use the real one), its real hook imports (mock exactly the modules it imports from), and the real mutation call signature (`mutate({ classNodeUuid, propertyUuid, ...updates })` or similar — assert with `expect.objectContaining` as shown). The current required toggle at :183-197 shows the pattern the tri-state replaces.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f compose.dev.yaml exec -T frontend npx vitest run src/features/properties/components/ClassPropertiesEditor.test.tsx`
Expected: FAIL — title/state not implemented.

- [ ] **Step 3: Implement TriStateToggle and replace the required toggle**

In `ClassPropertiesEditor.tsx`:
1. Add the `TriStateToggle` component (interface above). Use the existing icon button styling from the current required toggle (:183-197, `mdi-asterisk`). Icons: on = `mdi-asterisk`, off = `mdi-asterisk` with muted class, inherit = `mdi-asterisk` outline — or whatever the sprite has (check `frontend/src/components/ui/icons` / the sprite list; keep one icon with state classes if variants are missing).
2. Replace the required toggle with `<TriStateToggle value={cp.required} baseValue={prop.required} onChange={(v) => updateClassProperty.mutate({ ..., required: v })} ... />` where `prop` is looked up from `useProperties()`.
3. Add two more `TriStateToggle`s for `readonly` (icon `mdi-lock` / `mdi-lock-open-variant` style) and `hide_when_empty` (icon `mdi-eye-off` style — verify icon names exist in the sprite; fall back to text buttons if not).
4. Extend `useUpdateClassProperty`'s payload type in `useClassPropertyMutations.ts` to allow `readonly`/`hide_when_empty` and `null` values (Task 8 API function already passes them through).

- [ ] **Step 4: Add the default-override editor**

In each property row, next to the toggles, render `<DefaultValueEditor property={prop} value={cp.default_value} onChange={(v) => updateClassProperty.mutate({ ..., default_value: v })} />` (empty/unset = inherit → sends `default_value: null`, which the backend maps to `clear_defaults` on the edge). If horizontal space is tight, put it in the row's existing context menu as "Set default…" opening an inline popover — implementer's choice, but the test for it: setting a value calls the mutation with `default_value`. Add that test case to `ClassPropertiesEditor.test.tsx`.

- [ ] **Step 5: Run tests + type-check + lint**

Run: `docker compose -f compose.dev.yaml exec -T frontend npx vitest run src/features/properties/components/`
Expected: PASS (all property component tests)
Run: `docker compose -f compose.dev.yaml exec -T frontend npx tsc -b --noEmit && docker compose -f compose.dev.yaml exec -T frontend npm run lint`
Expected: clean (remove the Task-8 temporary `// TODO(task-11)` cast in this file while here)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/properties/components/ClassPropertiesEditor.tsx frontend/src/features/properties/components/ClassPropertiesEditor.test.tsx frontend/src/features/properties/hooks/useClassPropertyMutations.ts
git commit -m "feat(properties): tri-state attribute overrides and default editor in class editor"
```

---

### Task 12: Full verification + dev-stack rebuild

**Files:** none (verification only)

- [ ] **Step 1: Backend**

Run: `docker compose -f compose.dev.yaml exec -T backend uv run ruff check app/`
Run: `docker compose -f compose.dev.yaml exec -T backend uv run pytest tests/ -m "not slow" --no-cov`
Expected: lint clean, all tests pass

- [ ] **Step 2: Frontend**

Run: `docker compose -f compose.dev.yaml exec -T frontend npm run lint`
Run: `docker compose -f compose.dev.yaml exec -T frontend npx tsc -b --noEmit`
Run: `docker compose -f compose.dev.yaml exec -T frontend npm run test:run`
Expected: 0 lint errors (pre-existing warnings OK), clean tsc, all tests pass

- [ ] **Step 3: Rebuild and restart the dev stack**

Run: `docker compose -f compose.dev.yaml down && docker compose -f compose.dev.yaml up --build -d`
Then confirm all services healthy: `docker compose -f compose.dev.yaml ps`

- [ ] **Step 4: Browser verification checklist (hand to user)**

1. A `documento` block (inherits `fuente`) on a page: empty inherited properties now show inline in the list row, fillable in place.
2. Property page for a noisy property (e.g. `Recurrence`): toggle "Hide when empty" → empty occurrences disappear from block rows and move to the collapsed hidden section in page/focused view; setting a value makes them visible again.
3. Task block: open its Status property page — `required` is on, default = Pending. Try "Empty property" on a task's Status → resets to Pending (no error).
4. A required property without default: clearing → toast error, previous value restored.
5. Read-only property: editors disabled, "Empty/Remove" context actions disabled; API write returns 400 `readonly_property`.
6. Class page → properties editor: tri-state toggles cycle inherit → on → off; "inherit" shows the resolved base in the tooltip; default override editor sets/clears per class.
7. New task (Ctrl+Enter or class add): Status = Pending immediately.
8. Reload the page: all of the above persists.

- [ ] **Step 5: Snapshot commit (if any verification fixes were needed)**

```bash
git add -p   # stage only this task's fixes
git commit -m "fix(properties): verification fixes for attribute rollout"
```

---

## Risk Notes

- **`get_selection_line_by_id` / node-repo `get_by_id`** (Task 4 response mapping): verify these exist on the repositories; add thin wrappers if missing (the UUID-direction lookups already exist).
- **`model_fields_set` semantics** (Tasks 4): Pydantic v2 — confirmed available (project pins Pydantic 2.13.4).
- **`unnest ... WITH ORDINALITY`** (Task 3 edge SQL): requires the `class_ids` column to be a Postgres array — verified in the schema (`node.class_ids`).
- **Response `default_value` for boolean `false`/integer `0`** (Tasks 3-4): the old `_class_property_default_value` used `or`-chaining which swallowed `false`/`0`; the new `default_value_from_columns` uses explicit `is not None` — existing class defaults of `false`/`0` will now correctly appear in API responses. That is a behavior fix, not a regression.
- **Manual "Add property" path**: when a *required* property with a default is added to a node, the frontend sends an empty placeholder, and Task 5's enforcement rewrites it to the default — no `PropertiesSection.handleSelectProperty` change needed. Applying declared defaults when adding *optional* properties is out of scope (spec scopes default-on-add to required properties).
- **Concurrent agents**: this repo has other agents committing. Stage only the files listed per task; run `git status` before each commit.
