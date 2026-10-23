/**
 * PropertyDefinitionsSection — the class page's schema list (the Capacities
 * type-panel analogue, owner ruling 2026-10-20: the class-level inline
 * editor is GONE — the default moved to the property schema (one global
 * default per property, the Logseq shape) and `required` retired outright;
 * owner ruling 2026-10-21 retired `sequence` too, so a binding is a
 * presence row + the soft-unbind flag ONLY. The class page is now JUST the
 * list of assigned properties, rendered PURE ALPHABETICALLY by property
 * name — display-only ordering, nothing to sort).
 *
 * Section level: two groups — "Class properties" (the class's DIRECT
 * bindings) and "Inherited" (read-only rows attributed to the NEAREST
 * extends-ancestor that binds each schema; the row's cog opens the
 * base-definition editor).
 *
 * The row (the Notion database-property-row LOOK, with an explicit-action
 * twist — owner ruling 2026-10-21): the schema icon (the owner-2026-10-20
 * icon field, per-type glyph fallback) and the name (min-width 0 +
 * ellipsis) are IDENTITY DISPLAY ONLY — the name is NOT a button. NOTHING
 * else in the body — no chevron, no expansion, no inline fields, no drag.
 * Inactive bindings dim the name (the only disabled cue). Hover reveals
 * exactly TWO right-side affordances (owner ruling: no row tint, no
 * name-hover glow, no grip): the COG (definition settings — opens the S2
 * base-definition modal, PropertyEditModal, where the default editor lives
 * now, at the schema level; present even for system property schemas) and
 * the REMOVE × (the section-level danger confirm; hidden for system
 * property schemas — non-removable means absent). Explicit affordance over
 * whole-row click: a text-looking row must not pretend to be clickable,
 * and the same action on BOTH the row and a button is redundant.
 *
 * Bind property: the AddPill opens an anchored popover (SearchField,
 * keyboard-navigable listbox, rows = icon + name + type label) filtered
 * by query AND class-context eligibility (global + schemas scoped to
 * this class or its extends-ancestors, R1/R2). Its "Create …" row opens
 * the S1 creation modal pre-filled via requestPropertyCreate
 * ({ contextClassId }) — no instant text create-and-bind. ("Bind" is the
 * domain verb — API/SCHEMA.md/CLI — owner 2026-10-21; not "Add".)
 *
 * Binding attribution: the direct group is "schemas whose NEAREST binder
 * is this class" — the class's own registry rows (getRegistryBindings)
 * plus the read-synthesized system-seed specs (the same fallback
 * getClassBindings applies, so a fresh seeded system class keeps showing
 * its designed bindings); everything else inherited, attributed to the
 * nearest ancestor binding it (BFS over getClassParents, the
 * schemaEligibility closure pattern). getClassBindings already returns
 * the alphabetical order both groups render.
 */

import { useRef, useState } from "react";

import { foldSearchText } from "@notees/store";

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

import { labelFromClient } from "../../ui/dateDisplay.js";
import { Icon } from "../../ui/Icon.js";
import { AddPill } from "../../components/ui/fleet/AddPill.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { ConfirmationModal } from "../../components/ui/fleet/ConfirmationModal.js";
import { SearchField } from "../../components/ui/fleet/SearchField.js";
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
  // PURE ALPHABETICAL by property name (owner ruling 2026-10-21 — binding
  // sequence retired; both groups are display-only lists).
  const byName = (a: ClassBinding, b: ClassBinding) => a.name.localeCompare(b.name);
  direct.sort(byName);
  inherited.sort((a, b) => byName(a.binding, b.binding));
  return { direct, inherited };
}

function BindingRow({
  binding,
  schema,
  onOpenDefinition,
  onRemoveRequest,
}: {
  binding: ClassBinding;
  schema: ClientPropertySchema | undefined;
  /** The row's single action — opens the S2 base-definition modal. */
  onOpenDefinition: () => void;
  /** "Remove from class" — the section-level danger confirm. */
  onRemoveRequest: () => void;
}) {
  const name = schema?.name ?? binding.name;
  const isSystem = isSystemSchema(binding.propertySchemaId);

  return (
    <li
      data-property-schema-id={binding.propertySchemaId}
      className={`nt-propdef` + (binding.active ? "" : " nt-propdef--inactive")}
    >
      {/* The row body is IDENTITY DISPLAY ONLY (owner ruling 2026-10-21: the
          name is not a button — a text-looking row must not pretend to be
          clickable; the explicit COG below is the affordance). The row's
          TWO hover surfaces (owner ruling: no row tint, no grip): the COG
          (definition settings — the S2 base-definition modal, where the
          default editor lives now at the schema level) and the REMOVE ×
          (the section-level danger confirm; hidden for system property
          schemas — non-removable means absent). */}
      <div className="nt-propdef-row">
        <span className="nt-propdef-main">
          <span className="nt-propdef-icon" aria-hidden="true">
            <Icon path={schemaIconOf(schema, binding.type)} size={0.8} />
          </span>
          <span className="nt-propdef-name">{name}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          icon="mdi-cog-outline"
          className="nt-propdef-cog"
          aria-label={`Definition settings for ${name}`}
          onClick={onOpenDefinition}
        />
        {!isSystem && (
          <Button
            variant="ghost"
            size="sm"
            icon="mdi-close"
            className="nt-propdef-remove"
            aria-label={`Remove ${name} from class`}
            onClick={(event) => {
              event.stopPropagation();
              onRemoveRequest();
            }}
          />
        )}
      </div>
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
  const [editFor, setEditFor] = useState<string | null>(null);
  const [viewFor, setViewFor] = useState<string | null>(null);
  const [removeFor, setRemoveFor] = useState<ClassBinding | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  usePopupDismissal({
    popupRef: pickerRef,
    anchorRefs: [addButtonRef],
    isOpen: pickerOpen,
    onClose: () => setPickerOpen(false),
  });

  // The add-property popover: existing schemas not bound directly here,
  // filtered by query AND class-context eligibility (R1/R2 — global +
  // schemas scoped to this class or its extends-ancestors).
  const directIds = new Set(direct.map((binding) => binding.propertySchemaId));
  const queryTrimmed = query.trim();
  const queryFolded = foldSearchText(query.trim().toLowerCase());
  const candidates = client
    .listPropertySchemas()
    .filter((schema) => !directIds.has(schema.id))
    .filter((schema) => isSchemaEligibleForClass(client, schema, classId))
    .filter(
      (schema) =>
        queryFolded === "" || foldSearchText(schema.name.toLowerCase()).includes(queryFolded),
    );
  const canCreate =
    queryTrimmed !== "" &&
    !client.listPropertySchemas().some((s) => foldSearchText(s.name.toLowerCase()) === queryFolded);
  const optionCount = candidates.length + (canCreate ? 1 : 0);

  const addBinding = async (schemaId: string) => {
    // A binding is a presence row + the soft-unbind flag — no order to
    // allocate (class panels render alphabetically, owner ruling
    // 2026-10-21).
    await client.setClassProperty(classId, schemaId, {});
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
          <ul className="nt-propdefs-list">
            {direct.map((binding) => (
              <BindingRow
                key={binding.propertySchemaId}
                binding={binding}
                schema={client
                  .listPropertySchemas()
                  .find((s) => s.id === binding.propertySchemaId)}
                onOpenDefinition={() => setEditFor(binding.propertySchemaId)}
                onRemoveRequest={() => setRemoveFor(binding)}
              />
            ))}
          </ul>
        )}
        <div className="nt-propdefs-add">
          <AddPill
            ref={addButtonRef}
            label="Bind property"
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
              aria-label="Bind property"
              onKeyDown={onPickerKeyDown}
            >
              <SearchField
                autoFocus
                size="sm"
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
              const sourceName = labelFromClient(client, sourceClassId) ?? "Untitled";
              return (
                <li key={binding.propertySchemaId} className="nt-propdef-inherited-row">
                  {/* Identity display + source attribution — the same
                      explicit-cog criterion as the direct rows (the name is
                      NOT a button); the hover COG opens the base definition
                      (inherited from ${sourceName}). */}
                  <div className="nt-propdef-inherited-rowinner">
                    <span className="nt-propdef-inherited-main">
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
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="mdi-cog-outline"
                      className="nt-propdef-cog"
                      aria-label={`Definition settings for ${schema?.name ?? binding.name} (inherited from ${sourceName})`}
                      onClick={() => setEditFor(binding.propertySchemaId)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </NodeViewSection>
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
