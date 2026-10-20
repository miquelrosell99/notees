/**
 * PropertyDefinitionsSection — the class page's schema editor (the
 * Capacities type-panel analogue, owner ruling 2026-10-20: the old rows
 * crammed grip + glyph + name + chips + flag toggle + two expanders + ×
 * onto one line and the sidebar scrolled horizontally).
 *
 * Section level (v1 ClassPropertiesEditor parity): two groups —
 * "Class properties" (the class's DIRECT bindings, drag-sortable) and
 * "Inherited" (read-only rows attributed to the NEAREST extends-ancestor
 * that binds each schema; clicking one opens the base-definition editor —
 * nothing binding-level is editable there).
 *
 * Collapsed row (the 99% state, the Notion database-property-row
 * pattern): hover-revealed drag grip (dnd-kit, reorder → sequence
 * writes), the schema icon (the owner-2026-10-20 icon field, per-type
 * glyph fallback), and the name (min-width 0 + ellipsis). NOTHING else —
 * no chips, no row-level flag toggle, no ×. Inactive bindings dim the
 * name (the only disabled cue). The row click opens the config; hover
 * also reveals a ⋯ overflow ("Open property" / "Remove from class").
 *
 * Config panel (expanded, full section width, stacked groups that can
 * never overflow the sidebar) — CLASS-LEVEL ONLY (owner ruling R7,
 * 2026-10-20: the panel must not duplicate the base-definition modal):
 * a read-only header (icon + name — identity display, no rename); a
 * "For this class" group (the default-value editor → class.property.set
 * {defaultValue}, Required checkbox, the "Active on this class"
 * ToggleSwitch (PC4 `active` — off keeps the binding's settings but stops
 * applying them) — the only class-by-class binding fields:
 * defaultValue/required/sequence/active, sequence being the drag reorder
 * on the collapsed row); footer (a quiet "Edit definition…" → the S2
 * PropertyEditModal — the class page's path to the definition-level editor
 * (rename, type/Convert, multi, target classes, date settings all live
 * there); "Remove from class" behind a ConfirmationModal, HIDDEN for
 * system property schemas (and absent from the ⋯ overflow there too) —
 * the fixed SYSTEM_PROPERTY_UUIDS in @notees/domain).
 *
 * Add property: the AddPill opens an anchored popover (SearchField,
 * keyboard-navigable listbox, rows = icon + name + type label) filtered
 * by query AND class-context eligibility (global + schemas scoped to
 * this class or its extends-ancestors, R1/R2). Its "Create …" row opens
 * the S1 creation modal pre-filled via requestPropertyCreate
 * ({ contextClassId }) — no instant text create-and-bind.
 *
 * Binding attribution: the direct group is "schemas whose NEAREST binder
 * is this class" — the class's own registry rows (getRegistryBindings)
 * plus the read-synthesized system-seed specs (the same fallback
 * getClassBindings applies, so a fresh seeded system class keeps showing
 * its designed bindings); everything else inherited, attributed to the
 * nearest ancestor binding it (BFS over getClassParents, the
 * schemaEligibility closure pattern).
 */

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

import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type {
  ClassBinding,
  ClientPropertySchema,
  WorkspaceClient,
} from "@/core/workspace-client/index.js";

import { displayNameFromClient } from "../../ui/dateDisplay.js";
import { Icon } from "../../ui/Icon.js";
import { AddPill } from "../../components/ui/fleet/AddPill.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { Checkbox } from "../../components/ui/fleet/Checkbox.js";
import { ConfirmationModal } from "../../components/ui/fleet/ConfirmationModal.js";
import { ContextMenu } from "../../components/ui/fleet/ContextMenu.js";
import { SearchField } from "../../components/ui/fleet/SearchField.js";
import { ToggleSwitch } from "../../components/ui/fleet/ToggleSwitch.js";
import { usePopupDismissal } from "../../components/ui/fleet/usePopupDismissal.js";
import { PropertyEditModal } from "../metadata/PropertySettingsModal.js";
import { PropertyView } from "../metadata/PropertyView.js";
import { requestPropertyCreate } from "../metadata/PropertyCreateHost.js";
import { isSchemaEligibleForClass } from "../metadata/schemaEligibility.js";
import { NodeViewSection } from "../page-sections/NodeViewSection.js";
import "./PropertyDefinitionsSection.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** One mdi glyph per property type (the icon-field fallback). */
const TYPE_GLYPHS: Record<string, string> = {
  text: "mdi-format-letter-case",
  number: "mdi-pound",
  url: "mdi-link-variant",
  email: "mdi-email-outline",
  datetime: "mdi-calendar",
  select: "mdi-form-select",
  multi_select: "mdi-form-select",
  object: "mdi-target",
  asset: "mdi-image",
  boolean: "mdi-check-circle-outline",
};

/** System schemas never leave their class (v1's is_system rule): the
 *  "Remove from class" action is disabled for them. */
function isSystemSchema(schemaId: string): boolean {
  return (Object.values(SYSTEM_PROPERTY_UUIDS) as string[]).includes(schemaId);
}

/** The schema's identity icon: the icon field, then the type glyph. */
function schemaIconOf(schema: ClientPropertySchema | undefined, type: string): string {
  if (schema !== undefined && schema.icon !== null && schema.icon !== "") return schema.icon;
  return TYPE_GLYPHS[type] ?? "mdi-format-list-bulleted";
}

/** Transitive extends-ancestors, BFS order, cycle-guarded (self first). */
function ancestorLevelsOf(client: AnyClient, classId: string): string[] {
  const levels = [classId];
  const seen = new Set(levels);
  const queue = [classId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const parent of client.getClassParents(current)) {
      if (!seen.has(parent)) {
        seen.add(parent);
        levels.push(parent);
        queue.push(parent);
      }
    }
  }
  return levels;
}

/**
 * The schemas bound DIRECTLY at one class level: the registry rows plus
 * the read-synthesized system-seed specs (the identical fallback
 * getClassBindings applies for a reserved system class, so attribution
 * can never disagree with the effective list's membership).
 */
function ownSchemaIdsOf(client: AnyClient, classId: string): Set<string> {
  const own = new Set(client.getRegistryBindings(classId).map((b) => b.propertySchemaId));
  const systemClassName = (
    Object.entries(SYSTEM_CLASS_UUIDS) as Array<[string, string]>
  ).find(([, id]) => id === classId)?.[0];
  if (systemClassName !== undefined) {
    for (const [name, spec] of Object.entries(SYSTEM_PROPERTY_SPECS)) {
      if (spec === undefined || spec.bindTo !== systemClassName) continue;
      own.add(SYSTEM_PROPERTY_UUIDS[name as keyof typeof SYSTEM_PROPERTY_UUIDS]);
    }
  }
  return own;
}

/**
 * The direct/inherited split (v1 parity). The effective binding list is
 * first-wins across levels; the walk claims each schema at its NEAREST
 * binder (self first, then ancestors BFS), so a schema bound both here
 * and on an ancestor lands in the direct group and the inherited group
 * never duplicates it.
 */
function bindingAttributionOf(client: AnyClient, classId: string): {
  direct: ClassBinding[];
  inherited: Array<{ binding: ClassBinding; sourceClassId: string }>;
} {
  const effective = client.getClassBindings(classId);
  const direct: ClassBinding[] = [];
  const inherited: Array<{ binding: ClassBinding; sourceClassId: string }> = [];
  const claimed = new Set<string>();
  for (const level of ancestorLevelsOf(client, classId)) {
    for (const schemaId of ownSchemaIdsOf(client, level)) {
      if (claimed.has(schemaId)) continue;
      claimed.add(schemaId);
      const binding = effective.find((b) => b.propertySchemaId === schemaId);
      if (binding === undefined) continue;
      if (level === classId) direct.push(binding);
      else inherited.push({ binding, sourceClassId: level });
    }
  }
  return { direct, inherited };
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
  schema,
  expanded,
  onToggleExpanded,
  onMenu,
  onOpenDefinition,
  onRemoveRequest,
}: {
  client: AnyClient;
  classId: string;
  binding: ClassBinding;
  schema: ClientPropertySchema | undefined;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** The ⋯ overflow: "Open property" / "Remove from class". */
  onMenu: (anchor: HTMLElement) => void;
  /** "Edit definition…" — the S2 base-definition modal. */
  onOpenDefinition: () => void;
  /** "Remove from class" — the section-level danger confirm. */
  onRemoveRequest: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: binding.propertySchemaId,
  });

  const name = schema?.name ?? binding.name;
  const patch = (fields: Parameters<AnyClient["setClassProperty"]>[2]) =>
    void client.setClassProperty(classId, binding.propertySchemaId, fields);

  const isSystem = isSystemSchema(binding.propertySchemaId);

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
        <button
          type="button"
          className="nt-propdef-main"
          aria-expanded={expanded}
          aria-label={`Configure ${name}`}
          onClick={onToggleExpanded}
        >
          <span className="nt-propdef-icon" aria-hidden="true">
            <Icon path={schemaIconOf(schema, binding.type)} size={0.8} />
          </span>
          <span className="nt-propdef-name">{name}</span>
        </button>
        <button
          type="button"
          className="nt-propdef-more"
          aria-label={`Options for ${name}`}
          onClick={(event) => {
            event.stopPropagation();
            onMenu(event.currentTarget);
          }}
        >
          <Icon path="mdi-dots-horizontal" size={0.7} />
        </button>
      </div>
      {expanded && (
        <div className="nt-propdef-config">
          {/* Identity display only (R7): no rename, no icon picker — the
              definition-level fields live in the PropertyEditModal. */}
          <div className="nt-propdef-header">
            <span className="nt-propdef-icon" aria-hidden="true">
              <Icon path={schemaIconOf(schema, binding.type)} size={0.8} />
            </span>
            <span className="nt-propdef-name">{name}</span>
          </div>

          <fieldset className="nt-propdef-group">
            <legend>For this class</legend>
            <label className="nt-propdef-stack">
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
            <label className="nt-propdef-check">
              <Checkbox
                size="sm"
                checked={binding.required === true}
                onChange={(checked) => patch({ required: checked })}
                aria-label={`Required for ${name}`}
              />
              <span>Required</span>
            </label>
            <div className="nt-propdef-check">
              <span className="nt-propdef-label" id={`active-label:${binding.propertySchemaId}`}>
                Active on this class
              </span>
              <ToggleSwitch
                size="sm"
                leftLabel="Off"
                rightLabel="On"
                checked={binding.active}
                onChange={(enabled) => patch({ active: enabled })}
                aria-labelledby={`active-label:${binding.propertySchemaId}`}
              />
              <span className="nt-propdef-hint">
                Off keeps this class's settings but stops applying them.
              </span>
            </div>
          </fieldset>

          <div className="nt-propdef-footer">
            {/* The class page's path to the base-definition editor — rename,
                type/Convert, multi, target classes, date settings, scope. */}
            <Button variant="ghost" size="sm" onClick={onOpenDefinition}>
              Edit definition…
            </Button>
            {!isSystem && (
              <Button variant="danger" size="sm" onClick={onRemoveRequest}>
                Remove from class
              </Button>
            )}
          </div>
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
  const { direct, inherited } = bindingAttributionOf(client, classId);
  /** Expanded config rows (property-schema ids). */
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(new Set());
  const [menuFor, setMenuFor] = useState<{ binding: ClassBinding; anchor: HTMLElement } | null>(null);
  const [editFor, setEditFor] = useState<string | null>(null);
  const [viewFor, setViewFor] = useState<string | null>(null);
  const [removeFor, setRemoveFor] = useState<ClassBinding | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  usePopupDismissal({
    popupRef: pickerRef,
    anchorRefs: [addButtonRef],
    isOpen: pickerOpen,
    onClose: () => setPickerOpen(false),
  });

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
    const ids = direct.map((binding) => binding.propertySchemaId);
    const ordered = reorderIds(ids, String(active.id), String(over.id));
    ordered.forEach((schemaId, index) => {
      void client.setClassProperty(classId, schemaId, { sequence: index });
    });
  };

  // The add-property popover: existing schemas not bound directly here,
  // filtered by query AND class-context eligibility (R1/R2 — global +
  // schemas scoped to this class or its extends-ancestors).
  const directIds = new Set(direct.map((binding) => binding.propertySchemaId));
  const queryTrimmed = query.trim();
  const candidates = client
    .listPropertySchemas()
    .filter((schema) => !directIds.has(schema.id))
    .filter((schema) => isSchemaEligibleForClass(client, schema, classId))
    .filter(
      (schema) =>
        queryTrimmed === "" || schema.name.toLowerCase().includes(queryTrimmed.toLowerCase()),
    );
  const canCreate =
    queryTrimmed !== "" &&
    !client.listPropertySchemas().some((s) => s.name.toLowerCase() === queryTrimmed.toLowerCase());
  const optionCount = candidates.length + (canCreate ? 1 : 0);

  const addBinding = async (schemaId: string) => {
    await client.setClassProperty(classId, schemaId, { sequence: direct.length });
    setPickerOpen(false);
    setQuery("");
  };

  /** The "Create …" row opens the S1 modal pre-filled (no instant bind). */
  const createFromQuery = () => {
    setPickerOpen(false);
    setQuery("");
    requestPropertyCreate({ contextClassId: classId, initialName: queryTrimmed });
  };

  const activateIndex = (index: number) => {
    if (index < candidates.length) void addBinding(candidates[index]!.id);
    else createFromQuery();
  };

  const onPickerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      setPickerOpen(false);
      return;
    }
    if (optionCount === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % optionCount);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + optionCount) % optionCount);
    } else if (event.key === "Enter") {
      event.preventDefault();
      activateIndex(Math.min(activeIndex, optionCount - 1));
    }
  };

  const menuItems = (binding: ClassBinding) => [
    {
      id: "open-property",
      label: "Open property",
      icon: "mdi-open-in-app",
      onClick: () => setEditFor(binding.propertySchemaId),
    },
    // System properties have no remove entry — non-removable means absent.
    ...(isSystemSchema(binding.propertySchemaId)
      ? []
      : [{
          id: "remove-from-class",
          label: "Remove from class",
          icon: "mdi-close-circle-outline",
          danger: true,
          onClick: () => setRemoveFor(binding),
        }]),
  ];

  return (
    <>
      <NodeViewSection
        title="Class properties"
        icon={<Icon path="mdi-format-list-bulleted-square" size={0.9} />}
        count={direct.length}
        defaultExpanded={direct.length === 0}
        className="nt-propdefs"
      >
        {direct.length === 0 ? (
          <span className="nt-propdefs-empty">No property bindings.</span>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={direct.map((binding) => binding.propertySchemaId)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="nt-propdefs-list">
                {direct.map((binding) => (
                  <BindingRow
                    key={binding.propertySchemaId}
                    client={client}
                    classId={classId}
                    binding={binding}
                    schema={client
                      .listPropertySchemas()
                      .find((s) => s.id === binding.propertySchemaId)}
                    expanded={expandedRows.has(binding.propertySchemaId)}
                    onToggleExpanded={() => toggleRow(binding.propertySchemaId)}
                    onMenu={(anchor) => setMenuFor({ binding, anchor })}
                    onOpenDefinition={() => setEditFor(binding.propertySchemaId)}
                    onRemoveRequest={() => setRemoveFor(binding)}
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
            onClick={() => {
              setPickerOpen((open) => !open);
              setQuery("");
              setActiveIndex(0);
            }}
          />
          {pickerOpen && (
            <div
              ref={pickerRef}
              className="nt-propdef-picker"
              role="dialog"
              aria-label="Add property"
              onKeyDown={onPickerKeyDown}
            >
              <SearchField
                autoFocus
                value={query}
                placeholder="Search or create property…"
                aria-label="Search or create property"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onClear={() => setQuery("")}
              />
              <ul role="listbox" aria-label="Property schemas">
                {candidates.map((schema, index) => (
                  <li
                    key={schema.id}
                    role="option"
                    aria-selected={index === activeIndex}
                    className={index === activeIndex ? "is-active" : ""}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <button type="button" onClick={() => void addBinding(schema.id)}>
                      <span className="nt-propdef-picker-icon" aria-hidden="true">
                        <Icon path={schemaIconOf(schema, schema.type)} size={0.75} />
                      </span>
                      <span className="nt-propdef-picker-name">{schema.name}</span>
                      <span className="nt-propdef-picker-type">{schema.type}</span>
                    </button>
                  </li>
                ))}
                {candidates.length === 0 && !canCreate && (
                  <li className="nt-propdef-picker-empty">No eligible properties.</li>
                )}
              </ul>
              {canCreate && (
                <button
                  type="button"
                  className={
                    activeIndex === candidates.length
                      ? "nt-propdef-picker-create is-active"
                      : "nt-propdef-picker-create"
                  }
                  onMouseEnter={() => setActiveIndex(candidates.length)}
                  onClick={createFromQuery}
                >
                  Create property "{queryTrimmed}"
                </button>
              )}
            </div>
          )}
        </div>
      </NodeViewSection>

      {inherited.length > 0 && (
        <NodeViewSection
          title="Inherited"
          icon={<Icon path="mdi-family-tree" size={0.9} />}
          count={inherited.length}
          defaultExpanded={false}
          className="nt-propdefs-inherited"
        >
          <ul className="nt-propdefs-list">
            {inherited.map(({ binding, sourceClassId }) => {
              const schema = client
                .listPropertySchemas()
                .find((s) => s.id === binding.propertySchemaId);
              const sourceName = displayNameFromClient(client, sourceClassId) ?? sourceClassId;
              return (
                <li key={binding.propertySchemaId} className="nt-propdef-inherited-row">
                  <button
                    type="button"
                    className="nt-propdef-inherited-main"
                    title={`Open property (inherited from ${sourceName})`}
                    aria-label={`Open property ${schema?.name ?? binding.name}`}
                    onClick={() => setEditFor(binding.propertySchemaId)}
                  >
                    <span className="nt-propdef-icon" aria-hidden="true">
                      <Icon path={schemaIconOf(schema, binding.type)} size={0.8} />
                    </span>
                    <span className="nt-propdef-name">{schema?.name ?? binding.name}</span>
                    <span className="pill nt-propdef-source">
                      <span className="pill__left-icon" aria-hidden="true">
                        <Icon path={client.effectiveClassIcon(sourceClassId)} size={0.6} />
                      </span>
                      <span className="pill__text">{sourceName}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </NodeViewSection>
      )}

      {menuFor !== null && (
        <ContextMenu
          items={menuItems(menuFor.binding)}
          anchorEl={menuFor.anchor}
          onClose={() => setMenuFor(null)}
        />
      )}
      {editFor !== null && (
        <PropertyEditModal
          client={client}
          propertySchemaId={editFor}
          onClose={() => setEditFor(null)}
          onOpenView={() => {
            setViewFor(editFor);
            setEditFor(null);
          }}
        />
      )}
      {viewFor !== null && (
        <PropertyView client={client} propertySchemaId={viewFor} onClose={() => setViewFor(null)} />
      )}
      {removeFor !== null && (
        <ConfirmationModal
          isOpen
          title="Remove from class"
          message={`Remove "${removeFor.name}" from this class? Nodes keep their authored values; the property stops being offered here.`}
          confirmLabel="Remove from class"
          cancelLabel="Cancel"
          variant="danger"
          onConfirm={() => {
            void client.unsetClassProperty(classId, removeFor.propertySchemaId);
            setRemoveFor(null);
          }}
          onCancel={() => setRemoveFor(null)}
        />
      )}
    </>
  );
}
