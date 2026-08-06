# Property Attributes: required, default, readonly, hide-when-empty

Date: 2026-07-13
Status: Approved design, ready for implementation planning

## Problem

1. Class-declared properties that are empty do not show in list-view block rows
   (the `onlyWithValues` filter on `BlockRow`'s `PropertiesSection` drops them),
   so e.g. a `documento` block inheriting `fuente`'s property set shows nothing.
   Users want empty class properties visible and fillable, with a per-property
   opt-out ("hide when empty").
2. There is no way to guarantee a property always has a value (a task should
   always have a Status), to lock a property against editing, or to define a
   default value through the API/UI. The schema already carries partial
   infrastructure: `class_property.required` (unenforced), six typed
   `default_*` columns on `class_property` (API write path stubbed:
   `repository.add_class_property` deletes `default_value`, and
   `PATCH /classes/.../properties/...` silently ignores it), and
   `property.validation_rules` JSONB (min/max/pattern, client-side only).

## Decisions

- **Scope**: all four Odoo-style attributes in one round — `required`,
  `default`, `readonly`, `hide_when_empty` — since they share the same
  plumbing.
- **Placement**: attributes are defined at the **property level** (base), with
  **optional tri-state overrides on the class↔property association**
  (`class_property`). Rationale: ad-hoc and node-scoped properties have no
  class edge and must still carry attributes; overrides keep per-class control
  ("Status required on tasks").
- **Required semantics (default-or-reject)**: clearing an effective-required
  property resets it to its effective default when one exists; when no default
  exists the write is rejected (400 `required_property`), the client rolls back
  its optimistic update and toasts.
- **Enforcement point**: `PropertyService.set_property_value`
  (`app/features/properties/service.py:543`) — the single choke point shared by
  REST writes and sync ops (`app/features/sync/service_v2.py:445`) — with an
  explicit `enforce_attributes=False` bypass for internal callers (task
  automations, seeding, migrations, default application).
- **Hide-when-empty display**: an empty property whose effective
  `hide_when_empty` is true joins the *hidden* bucket (collapsed hidden section
  in page/focused view, still fillable; omitted in list-view rows).

## Data model

### Property level (new columns on `property`)

- `required BOOLEAN NOT NULL DEFAULT FALSE`
- `readonly BOOLEAN NOT NULL DEFAULT FALSE`
- `hide_when_empty BOOLEAN NOT NULL DEFAULT FALSE`
- `default_integer BIGINT`, `default_float DOUBLE PRECISION`,
  `default_text TEXT`, `default_boolean BOOLEAN`,
  `default_node_id BIGINT REFERENCES node(id)`,
  `default_selection_id BIGINT REFERENCES property_selection_line(id)`
  — mirrors the six typed columns already on `class_property`, keeping FK
  integrity for node/selection defaults (no JSONB).

### Class level (overrides on `class_property`)

- `required` becomes **nullable tri-state**: NULL = inherit, true = force on,
  false = force off. Migration converts existing all-`false` rows to NULL
  (nothing enforced required before — zero behavior change); existing `true`
  rows are preserved.
- New nullable `readonly BOOLEAN`, `hide_when_empty BOOLEAN` overrides.
- Existing `default_*` columns already act as overrides (non-NULL wins).

`class_property.hidden` stays as-is (orthogonal "always in hidden section"
display flag).

### Resolution (node + property → effective attributes)

A property reaches a node either ad-hoc (no class edge) or through class edges
in the node's class closure: direct classes first, then ancestors by ascending
distance — the same inheritance walk used by `_apply_class_property_defaults`
(`app/features/nodes/class_management_service.py:305-352`) and the frontend's
`useClassProperties(classId, includeInherited=true)`.

Effective value = nearest edge's override if non-NULL, else the property base.
Ties between edges at the same distance break by the node's `class_ids`
ordering. Ad-hoc properties use the base. Rule: "the most specific class wins;
otherwise the property decides."

### Default application

- Adding a required property with a default to a node (manual "Add property"
  or class assignment) applies the default immediately instead of an empty
  placeholder — otherwise the node instantly violates its own constraint.
  Class assignment already does this for class-level defaults; extend it to
  property-level defaults and the manual-add path
  (`PropertiesSection.handleSelectProperty` / `handleCreateNewProperty`).

## Enforcement

All in `PropertyService.set_property_value` / `set_property_value_by_uuid`:

- **Empty** means: null, empty string, empty list. For multi-value properties,
  "required" means at least one value.
- Clearing an effective-required property:
  - effective default exists → rewrite the clear into a reset-to-default
    (200; response carries the defaulted value);
  - no default → `ValueError` subclass mapped to 400 with structured code
    `required_property`.
- Writing to an effective-readonly property → 400 `readonly_property`, unless
  the caller passes `enforce_attributes=False` (task automations —
  `TaskAutomationService` closed-date set/clear and recurrence status reset —
  seeding, migrations, and the default-application path itself).
- New error codes surface in the API error body so the frontend can toast a
  specific message.

### Sync

`service_v2._apply_set_property` already catches `PropertyNotFoundError` /
`ValueError` and skips the op with a warning. Required/readonly violations
raise from the same service method, so they inherit that behavior: skipped,
never requeued — a stale offline op cannot poison the outbox.

## Display

- `PropertiesSection` computes `effectiveHidden = classProp.hidden ||
  (effectiveHideWhenEmpty && !hasValue)` and buckets entries as today (visible
  vs collapsed hidden section). List-view rows (`inline` mode) render only the
  visible bucket, so empty hide-when-empty properties disappear there.
- **Block-row fix**: remove `onlyWithValues` from `BlockRow`'s
  `PropertiesSection` usage. Class-declared properties render in list rows even
  when empty (visible bucket); empty editors show their empty state and are
  fillable inline.
- Readonly entries render disabled value editors and have "Empty property" /
  "Remove from node" context actions disabled.
- Required entries: "Empty property" context action hidden when no effective
  default exists; kept when a default exists (acts as "reset to default").
- Icon-visibility properties unchanged: valued ones render as bullet/content
  icons and stay out of the section for non-main nodes.

## UI

- **Property page** (`PropertyConfigSection.tsx`): new "Attributes" group —
  Required / Read-only / Hide-when-empty toggles and a live default-value
  editor (replacing the dead stub at line 48), type-appropriate (selection
  dropdown, date input, number, boolean, text; node-relation reuses the cell
  editor's node picker). Persisted via `PUT /api/properties/{uuid}`;
  `PropertyUpdateRequest` gains the four fields, and the update path persists
  the six typed default columns (clearing = all NULL).
- **Class editor** (`ClassPropertiesEditor.tsx`): the existing required toggle
  becomes a tri-state cycle (inherit → on → off) with a tooltip showing the
  resolved base (e.g. "inherit (required)"); matching tri-states for readonly
  and hide-when-empty; default-override editor (empty = inherit). All via
  `PATCH /api/properties/classes/{uuid}/properties/{propUuid}` — this round
  fixes `update_class_property` (service.py:826-844 / repository.py:1573-1606)
  to persist `default_value`, and fixes `add_class_property`
  (repository.py:1539) so defaults persist on attach.
- `ClassPropertyResponse` / `PropertyResponse` and the frontend `Property` /
  `ClassProperty` types gain the new fields.

## Migration & seed

- Append `DO $$` blocks to `app/db/schema/sql.py` (existing pattern) adding the
  new `property` columns, the six `property.default_*` columns, and the
  `class_property` override columns; `class_property.required` → nullable with
  `false` → `NULL` data migration.
- Seed (`app/db/schema/init.py`) + migration for existing workspaces: the
  system task-status property (`SYSTEM_PROPERTY_UUIDS.task_status`) gets
  property-level `required=true` and `default_selection_id` = Pending option
  (the default moves from the class edge to the property base; the edge keeps
  working as an override). One-time backfill: task nodes without a Status value
  receive Pending, so the constraint is never born violated.
- All other properties default to false/NULL — opt-in per property.
- Optional (user's call at implementation time): seed `hide_when_empty=true`
  on noisy system task properties (e.g. Recurrence) for cleaner task rows.

## Testing

- Backend, new `tests/test_property_attributes.py`: resolution (base / tri-state
  override / nearest-class-wins / ad-hoc fallback), default-or-reject on clear,
  readonly rejection + internal bypass, default application on property add and
  on class assignment, multi-value "at least one" semantics, sync-op skip,
  backfill migration, PATCH-defaults regression (currently silently ignored).
- Frontend (Vitest): `PropertiesSection` hide-when-empty bucketing and readonly
  rendering; `BlockRow` renders empty class properties; new
  `ClassPropertiesEditor` tests for the tri-state cycles (component currently
  untested); `useSetNodeProperty` 400 → rollback + toast (rollback exists,
  assert the required/readonly path).
- Verification per project convention: `ruff check app/`, backend pytest
  (`-m "not slow"`), frontend `npm run lint`, `tsc -b --noEmit`,
  `npm run test:run`; then rebuild/restart the dev stack
  (`docker compose -f compose.dev.yaml down && up --build`) and verify in the
  browser: empty class properties visible in list rows, hide-when-empty hides
  them, clearing required Status resets to Pending, readonly editors disabled.

## Out of scope

- `validation_rules` (min/max/pattern) server-side enforcement — untouched.
- Per-user or per-workspace attribute policies.
- Bulk backfill of defaults for user-defined properties (only the system
  task-status property is backfilled).
