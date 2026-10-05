/**
 * PropertyDefinitionsSection — the class page's schema editor (the
 * Capacities type-panel analogue): one row per property binding.
 *
 * Collapsed row: drag grip (sequence order), a per-type glyph, the name,
 * only-set chips (target-class filter, default, date precision), the three
 * flag toggles (Required / Readonly / Hide-when-empty) as icon buttons, a
 * "Configure" expander and a remove ×. The expanded row is the full config
 * panel: rename, type (read-only, create-time contract), target-class pills,
 * typed default, checkbox flags, the PC4 Enabled switch, date precision /
 * qualified. Expanded when the class has no bindings (invites setup),
 * collapsed once configured.
 *
 * Writes: binding fields (sequence/default/required/readonly/hideWhenEmpty)
 * via class.property.set; schema fields (name/targetClassFilter/date
 * precision/dateQualified) via property.schema.update. Add: a search/create
 * popup over existing property schemas.
 *
 * PC4 (§34.56): the Enabled switch renders the binding's live `active` flag
 * but stays DISABLED — LOCKSTEP-PENDING (the `active` payload key ships inert
 * until the GTK m6+ / Flutter m16+ releases parse it; flipping it now would
 * fail old clients loud). Activation = flip BINDING_ACTIVE_WRITES_ENABLED.
 */

/** PC4 lockstep gate — activation flips this single constant (§34.54 pattern). */
const BINDING_ACTIVE_WRITES_ENABLED = true; // lockstep SHIPPED: GTK/Flutter v3.0.0
const LOCKSTEP_PENDING_NOTE =
  "Available once all clients catch up — the protocol batch (PG5/PC4/PC6) is pending the GTK/Flutter lockstep releases.";

import { useRef, useState } from "react";

import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BindingDisplay, ClassBinding, WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameFromClient } from "../../dateDisplay.js";
import { Icon } from "../../Icon.js";
import { AddPill } from "../ui/AddPill.js";
import { Checkbox } from "../ui/Checkbox.js";
import { SelectionButton } from "../ui/SelectionButton.js";
import { ToggleSwitch } from "../ui/ToggleSwitch.js";
import { NodeViewSection } from "../NodeViewSection.js";
import "./PropertyDefinitionsSection.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** One mdi glyph per property type (read-only identity cue). */
const TYPE_GLYPHS: Record<string, string> = {
  text: "mdi-format-letter-case",
  number: "mdi-pound",
  url: "mdi-link-variant",
  email: "mdi-email-outline",
  date: "mdi-calendar",
  date_range: "mdi-calendar-range",
  select: "mdi-form-select",
  object: "mdi-target",
  image: "mdi-image",
  boolean: "mdi-check-circle-outline",
};

/** The three per-binding flags, as collapsed-row icon toggles. */
const FLAG_TOGGLES = [
  { field: "required", label: "Required", icon: "mdi-asterisk" },
  { field: "readonly", label: "Readonly", icon: "mdi-lock-outline" },
  { field: "hideWhenEmpty", label: "Hide when empty", icon: "mdi-eye-off-outline" },
] as const;

/** Display names for a target-class filter's entries (ids or names). */
function filterNamesOf(client: AnyClient, entries: string[] | null): string[] {
  if (entries === null) return [];
  const classes = client.listClasses();
  return entries
    .map((entry) => {
      const cls = classes.find((c) => c.id === entry) ?? classes.find((c) => c.name === entry);
      if (cls !== undefined) return displayNameFromClient(client, cls.id) ?? entry;
      return entry;
    })
    .filter((name) => name !== "");
}

/** Resolve a filter's entries to class ids (ids pass through; names map). */
function filterIdsOf(client: AnyClient, entries: string[] | null): string[] {
  if (entries === null) return [];
  const classes = client.listClasses();
  return entries
    .map((entry) => classes.find((c) => c.id === entry)?.id ?? classes.find((c) => c.name === entry)?.id)
    .filter((id): id is string => id !== undefined);
}

function reorderIds(ids: string[], activeId: string, overId: string): string[] {
  const next = ids.slice();
  const from = next.indexOf(activeId);
  const to = next.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return ids;
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

function BindingRow({
  client,
  classId,
  binding,
  expanded,
  onToggleExpanded,
}: {
  client: AnyClient;
  classId: string;
  binding: ClassBinding;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: binding.propertySchemaId,
  });

  const name = binding.name;
  const patch = (fields: Parameters<AnyClient["setClassProperty"]>[2]) =>
    void client.setClassProperty(classId, binding.propertySchemaId, fields);
  const patchSchema = (fields: Parameters<AnyClient["updatePropertySchema"]>[1]) =>
    void client.updatePropertySchema(binding.propertySchemaId, fields);

  const schemaRow = client.listPropertySchemas().find((s) => s.id === binding.propertySchemaId);
  const filterEntries = schemaRow?.targetClassFilter ?? binding.targetClassFilter;
  const filterIds = filterIdsOf(client, filterEntries);
  const filterNames = filterNamesOf(client, filterEntries);
  const isDate = binding.type === "date" || binding.type === "date_range";

  return (
    <li
      ref={setNodeRef}
      data-property-schema-id={binding.propertySchemaId}
      className={
        `nt-propdef${expanded ? " nt-propdef--expanded" : ""}` +
        (isDragging ? " nt-propdef--dragging" : "") +
        (binding.active ? "" : " nt-propdef--inactive")
      }
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="nt-propdef-row">
        <button
          type="button"
          className="nt-propdef-grip"
          aria-label={`Reorder ${name}`}
          {...attributes}
          {...listeners}
        >
          <Icon path="mdi-drag-vertical" size={0.7} />
        </button>
        <span
          className="nt-propdef-type"
          aria-label={`Type: ${binding.type}${binding.multi ? " (multi)" : ""}`}
          title={`${binding.type}${binding.multi ? " · multi" : ""}`}
        >
          <Icon path={TYPE_GLYPHS[binding.type] ?? "mdi-format-list-bulleted"} size={0.8} />
        </span>
        <span className="nt-propdef-name">{name}</span>
        {!binding.active && (
          <span className="nt-propdef-chip nt-propdef-chip--inactive" title={LOCKSTEP_PENDING_NOTE}>
            disabled
          </span>
        )}
        {filterNames.length > 0 && (
          <span className="nt-propdef-chip nt-propdef-chip--filter">→ {filterNames.join(", ")}</span>
        )}
        {binding.defaultValue !== null && binding.defaultValue !== undefined && (
          <button type="button" className="nt-propdef-chip" onClick={onToggleExpanded}>
            default: {String(binding.defaultValue)}
          </button>
        )}
        {isDate && (
          <span className="nt-propdef-chip" title="Date precision">
            {binding.datePrecision ?? "day"}
          </span>
        )}
        <span className="nt-propdef-flags">
          {FLAG_TOGGLES.map(({ field, label, icon }) => (
            <button
              key={field}
              type="button"
              className={
                binding[field] === true
                  ? "nt-propdef-flag nt-propdef-flag--on"
                  : "nt-propdef-flag"
              }
              aria-label={`${label} for ${name}`}
              title={label}
              aria-pressed={binding[field] === true}
              onClick={() => patch({ [field]: binding[field] !== true } as Parameters<AnyClient["setClassProperty"]>[2])}
            >
              <Icon path={icon} size={0.7} />
            </button>
          ))}
        </span>
        <button
          type="button"
          className="nt-propdef-more"
          aria-label={`Configure ${name}`}
          aria-expanded={expanded}
          onClick={onToggleExpanded}
        >
          <Icon path="mdi-dots-horizontal" size={0.7} />
        </button>
        <button
          type="button"
          className="nt-propdef-remove"
          aria-label={`Remove binding ${name}`}
          onClick={() => void client.unsetClassProperty(classId, binding.propertySchemaId)}
        >
          ×
        </button>
      </div>
      {expanded && (
        <div className="nt-propdef-config">
          <label className="nt-propdef-field">
            <span className="nt-propdef-label">Name</span>
            <input
              key={`name:${binding.propertySchemaId}:${name}`}
              type="text"
              className="nt-propdef-input"
              defaultValue={name}
              aria-label="Property name"
              onBlur={(event) => {
                const next = event.target.value.trim();
                if (next !== "" && next !== name) patchSchema({ name: next });
              }}
            />
          </label>
          <p className="nt-propdef-meta">
            Type: {binding.type}
            {binding.multi ? " (multi)" : ""}
          </p>
          {binding.type === "object" && filterIds.length > 0 && (
            <div className="nt-propdef-field">
              <span className="nt-propdef-label">Target classes</span>
              {/* Read-only: the wire's propertySchema.update carries no
                  targetClassFilter (create-only field) — editing would need a
                  protocol addition (three-way lockstep), out of this slice. */}
              <span className="nt-propdef-chips">
                {filterIds.map((classIdEntry) => {
                  const label = displayNameFromClient(client, classIdEntry) ?? classIdEntry;
                  return (
                    <span key={classIdEntry} className="pill">
                      <span className="pill__left-icon">
                        <Icon path={client.effectiveClassIcon(classIdEntry)} size={0.7} />
                      </span>
                      <span className="pill__text nt-chip-label">{label}</span>
                    </span>
                  );
                })}
              </span>
            </div>
          )}
          <label className="nt-propdef-field">
            <span className="nt-propdef-label">Default value</span>
            <input
              key={`def:${binding.propertySchemaId}:${binding.defaultValue ?? ""}`}
              type="text"
              className="nt-propdef-input"
              placeholder="None"
              defaultValue={binding.defaultValue ?? ""}
              aria-label={`Default for ${name}`}
              onBlur={(event) => {
                const value = event.target.value;
                if (value !== (binding.defaultValue ?? "")) patch({ defaultValue: value });
              }}
            />
          </label>
          {FLAG_TOGGLES.map(({ field, label }) => (
            <label key={field} className="nt-propdef-check">
              <Checkbox
                size="sm"
                checked={binding[field] === true}
                onChange={(event) =>
                  patch({ [field]: event.target.checked } as Parameters<AnyClient["setClassProperty"]>[2])
                }
              />
              <span>{label}</span>
            </label>
          ))}
          {/* PC4: the soft-unbind switch renders live state but is inert until
              the lockstep wave — flipping it would write the `active` payload
              key, which pre-m6/m16 clients reject loud. */}
          <div className="nt-propdef-check" title={LOCKSTEP_PENDING_NOTE}>
            <ToggleSwitch
              size="sm"
              leftLabel="Disabled"
              rightLabel="Enabled"
              checked={binding.active}
              disabled={!BINDING_ACTIVE_WRITES_ENABLED}
              onChange={(enabled) => {
                if (BINDING_ACTIVE_WRITES_ENABLED) patch({ active: enabled });
              }}
              aria-label={`Enabled for ${name}`}
            />
            <span>Enabled {!BINDING_ACTIVE_WRITES_ENABLED && "(pending client lockstep)"}</span>
          </div>
          {/* §34.89: where the value reads — the properties panel (default),
              an icon button next to the block bullet, or one before the block
              content (select/multi_select AND boolean; the Logseq-DB
              value-position behavior). Booleans render the same button with
              two synthetic circle options (check-circle true, hollow circle
              false — the owner-specified glyphs). The wire stores "panel"
              explicitly for the default. */}
          {(binding.type === "select" ||
            binding.type === "multi_select" ||
            binding.type === "boolean") && (
            <label className="nt-propdef-field">
              <span className="nt-propdef-label">Value display</span>
              <SelectionButton
                size="sm"
                aria-label={`Value display for ${name}`}
                options={[
                  { value: "panel", icon: "mdi-format-list-bulleted-square", label: "Properties panel" },
                  { value: "bullet", icon: "mdi-circle-medium", label: "Next to bullet" },
                  { value: "inline", icon: "mdi-format-align-left", label: "Before content" },
                ]}
                value={binding.display ?? "panel"}
                onChange={(value) => patch({ display: value as BindingDisplay })}
              />
            </label>
          )}
          {isDate && (
            <label className="nt-propdef-field">
              <span className="nt-propdef-label">Precision</span>
              <select
                className="nt-propdef-input"
                aria-label={`Date precision for ${name}`}
                value={binding.datePrecision ?? "day"}
                onChange={(event) =>
                  patchSchema({ datePrecision: event.target.value as "year" | "month" | "day" })
                }
              >
                <option value="day">day</option>
                <option value="month">month</option>
                <option value="year">year</option>
              </select>
            </label>
          )}
          {binding.type === "object" && (
            <label className="nt-propdef-check">
              <Checkbox
                size="sm"
                checked={binding.dateQualified === true}
                onChange={(event) => patchSchema({ dateQualified: event.target.checked })}
              />
              <span>Date qualified</span>
            </label>
          )}
        </div>
      )}
    </li>
  );
}

export function PropertyDefinitionsSection({
  client,
  classId,
}: {
  client: AnyClient;
  classId: string;
}) {
  const bindings = client.getClassBindings(classId);
  /** Expanded config rows (property-schema ids). */
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const addButtonRef = useRef<HTMLButtonElement | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const toggleRow = (schemaId: string) => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(schemaId)) next.delete(schemaId);
      else next.add(schemaId);
      return next;
    });
  };

  /** Drag reorder: rewrite every row's sequence in the dropped order. */
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const ids = bindings.map((binding) => binding.propertySchemaId);
    const ordered = reorderIds(ids, String(active.id), String(over.id));
    ordered.forEach((schemaId, index) => {
      void client.setClassProperty(classId, schemaId, { sequence: index });
    });
  };

  const boundSchemaIds = new Set(bindings.map((binding) => binding.propertySchemaId));
  const schemas = client.listPropertySchemas();
  const candidates = schemas.filter(
    (schema) =>
      !boundSchemaIds.has(schema.id) &&
      (query.trim() === "" || schema.name.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const queryTrimmed = query.trim();
  const canCreate =
    queryTrimmed !== "" && !schemas.some((s) => s.name.toLowerCase() === queryTrimmed.toLowerCase());

  const addBinding = async (schemaId: string) => {
    await client.setClassProperty(classId, schemaId, { sequence: bindings.length });
    setPickerOpen(false);
    setQuery("");
  };

  const createAndBind = async () => {
    const schemaId = await client.createPropertySchema({ name: queryTrimmed, type: "text" });
    await addBinding(schemaId);
  };

  return (
    <NodeViewSection
      title="Class properties"
      icon={<Icon path="mdi-format-list-bulleted-square" size={0.9} />}
      count={bindings.length}
      defaultExpanded={bindings.length === 0}
      className="nt-propdefs"
    >
      {bindings.length === 0 ? (
        <span className="nt-propdefs-empty">No property bindings.</span>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={bindings.map((binding) => binding.propertySchemaId)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="nt-propdefs-list">
              {bindings.map((binding) => (
                <BindingRow
                  key={binding.propertySchemaId}
                  client={client}
                  classId={classId}
                  binding={binding}
                  expanded={expandedRows.has(binding.propertySchemaId)}
                  onToggleExpanded={() => toggleRow(binding.propertySchemaId)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      <div className="nt-propdefs-add">
        <AddPill
          ref={addButtonRef}
          label="Add property"
          aria-expanded={pickerOpen}
          onClick={(element) => {
            addButtonRef.current = element;
            setPickerOpen((open) => !open);
            setQuery("");
          }}
        />
        {pickerOpen && (
          <div className="nt-propdef-picker" role="dialog" aria-label="Add property">
            <input
              autoFocus
              value={query}
              placeholder="Search or create property…"
              onChange={(event) => setQuery(event.target.value)}
            />
            <ul>
              {candidates.map((schema) => (
                <li key={schema.id}>
                  <button type="button" onClick={() => void addBinding(schema.id)}>
                    <span className="nt-propdef-picker-name">{schema.name}</span>
                    <span className="nt-propdef-picker-type">{schema.type}</span>
                  </button>
                </li>
              ))}
            </ul>
            {canCreate && (
              <button type="button" className="nt-propdef-picker-create" onClick={() => void createAndBind()}>
                Create property "{queryTrimmed}"
              </button>
            )}
          </div>
        )}
      </div>
    </NodeViewSection>
  );
}
