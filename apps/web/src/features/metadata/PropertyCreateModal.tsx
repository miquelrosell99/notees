/**
 * PropertyCreateModal (S1, the property-definition surfaces batch) — the
 * pre-creation modal (owner ruling 2026-10-20: creation opens a modal
 * BEFORE any op is written), the v1 PropertyCreateModal port 1:1 adapted to
 * the v2 types and the fleet kit:
 *
 *  - name (autofocus, live duplicate check against listPropertySchemas);
 *  - icon (IconPickerPopup — the same one ClassCreateModal uses);
 *  - type grid (v2's 11 types, radiogroup, keyboard-navigable);
 *  - single/multi toggle (multi-capable types);
 *  - options editor (select/multi_select: add/remove/reorder, per-option
 *    icon+color — PropertyOptionsEditor);
 *  - targetClassFilter class multi-pick (object/asset/datetime);
 *  - scope control (global default / "local to classes" — the sole locality
 *    authority, owner ruling 2026-10-20 R1);
 *  - default value — ONLY in class context (contextClassId given): defaults
 *    are binding-level (the v2 correction over v1), so the field writes the
 *    class binding after the create; elsewhere the field is omitted and the
 *    caller decides the follow-up via onCreated.
 *
 * Emits client.createPropertySchema ONCE, on confirm. In class context the
 * create is followed by setClassProperty(classId, id, { sequence, … }) and
 * the optional binding defaultValue write. Footer: Cancel / Create Property.
 */

import { useEffect, useRef, useState } from "react";

import type { ClientPropertyOption } from "@/core/workspace-client/index.js";

import { Modal } from "../../components/ui/fleet/Modal.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { ToggleSwitch } from "../../components/ui/fleet/ToggleSwitch.js";
import { SelectionButton } from "../../components/ui/fleet/SelectionButton.js";
import { IconPickerPopup } from "../icon-picker/IconPickerPopup.js";
import { IconTriggerButton, PropertyField } from "./ClassMultiPickField.js";
import { ClassMultiPickField } from "./ClassMultiPickField.js";
import { PropertyOptionsEditor } from "./PropertyOptionsEditor.js";
import { PropertyScopeControl } from "./PropertyScopeControl.js";
import { defaultCapable } from "./shared.js";
import type { AnyClient } from "./shared.js";
import "./PropertyCreateModal.css";

export interface PropertyTypeOption {
  type: string;
  label: string;
  description: string;
  supportsMulti: boolean;
}

/** v2's wire types (the conversion targets register, plus the image zombie). */
export const PROPERTY_TYPE_OPTIONS: PropertyTypeOption[] = [
  { type: "text", label: "Text", description: "Node-backed text (mentions, links)", supportsMulti: true },
  { type: "number", label: "Number", description: "A number, with optional formatting", supportsMulti: false },
  { type: "boolean", label: "Checkbox", description: "True/false value", supportsMulti: false },
  { type: "datetime", label: "Date", description: "Link to a day, month, or year node", supportsMulti: false },
  { type: "url", label: "URL", description: "Web link", supportsMulti: false },
  { type: "email", label: "Email", description: "Email address", supportsMulti: false },
  { type: "select", label: "Select", description: "Choose one option", supportsMulti: true },
  { type: "multi_select", label: "Multi-select", description: "Choose several options", supportsMulti: true },
  { type: "object", label: "Object", description: "Link to another node", supportsMulti: true },
  { type: "image", label: "Image", description: "Image asset (value shape pending)", supportsMulti: false },
  { type: "asset", label: "Asset", description: "Link to an uploaded file", supportsMulti: true },
];

/** Node-typed schemas constrain their targets to picked classes. */
const FILTERED_TYPES = new Set(["object", "asset", "datetime"]);

export interface PropertyCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  client: AnyClient;
  /** The picker's typed query, carried in as the name (every entry point). */
  initialName?: string | undefined;
  /** Pre-selected type (e.g. the verb flow pre-selects object). */
  initialType?: string | undefined;
  /** Pre-selected cardinality (the verb flow pre-selects multi). */
  initialMulti?: boolean | undefined;
  /** Class context: the create binds the schema to this class (+ default field). */
  contextClassId?: string | undefined;
  /** Called with the new schema id AND its type after the create (+ class
   *  follow-ups) — the type rides explicitly because a cached
   *  listPropertySchemas read can still be stale at callback time. */
  onCreated?: ((schemaId: string, type: string) => void) | undefined;
}

export function PropertyCreateModal({
  isOpen,
  onClose,
  client,
  initialName = "",
  initialType,
  initialMulti = false,
  contextClassId,
  onCreated,
}: PropertyCreateModalProps) {
  const [name, setName] = useState(initialName);
  const [icon, setIcon] = useState<string | null>(null);
  const [type, setType] = useState(
    initialType ?? "text",
  );
  const [multi, setMulti] = useState(initialMulti);
  const [options, setOptions] = useState<ClientPropertyOption[]>([]);
  const [targetClassIds, setTargetClassIds] = useState<string[]>([]);
  const [scopeLocal, setScopeLocal] = useState(false);
  const [scopeClassIds, setScopeClassIds] = useState<string[]>([]);
  const [datePrecision, setDatePrecision] = useState<"day" | "month" | "year">("day");
  const [dateQualified, setDateQualified] = useState(false);
  /** The class-context binding default (null = no default written). */
  const [defaultValue, setDefaultValue] = useState<string | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconButtonRef = useRef<HTMLButtonElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const typeOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Reset the form each time the modal opens (v1 parity) — the initial
  // props are the OPEN-TIME prefill, not live bindings.
  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setIcon(null);
      setType(initialType ?? "text");
      setMulti(initialMulti);
      setOptions([]);
      setTargetClassIds([]);
      setScopeLocal(false);
      setScopeClassIds([]);
      setDatePrecision("day");
      setDateQualified(false);
      setDefaultValue(null);
      setIconPickerOpen(false);
      setBusy(false);
      setError(null);
      nameInputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-time prefill only
  }, [isOpen]);

  const nameError =
    name.trim() !== "" &&
    client
      .listPropertySchemas()
      .some((s) => s.name.toLowerCase() === name.trim().toLowerCase())
      ? "A property with this name already exists"
      : null;

  const typeOption = PROPERTY_TYPE_OPTIONS.find((t) => t.type === type);
  const multiEligible = typeOption?.supportsMulti === true && type !== "multi_select";

  const canCreate =
    name.trim() !== "" &&
    nameError === null &&
    !busy &&
    (!scopeLocal || scopeClassIds.length > 0);

  const handleTypeChange = (next: string) => {
    setType(next);
    if (next !== "multi_select") setMulti(false);
    setDefaultValue(null);
  };

  const handleCreate = async () => {
    if (!canCreate) return;
    setError(null);
    setBusy(true);
    try {
      const payload: Parameters<AnyClient["createPropertySchema"]>[0] = {
        name: name.trim(),
        type,
      };
      if (multiEligible && multi) payload.multi = true;
      if (icon !== null && icon !== "") payload.icon = icon;
      // Exactly one spelling of global: the key rides only when non-empty.
      if (scopeLocal && scopeClassIds.length > 0) payload.scopeClassIds = scopeClassIds;
      if ((type === "select" || type === "multi_select") && options.length > 0) {
        payload.options = options;
      }
      if (FILTERED_TYPES.has(type) && targetClassIds.length > 0) {
        payload.targetClassFilter = targetClassIds;
      }
      if (type === "datetime") {
        if (datePrecision !== "day") payload.datePrecision = datePrecision;
        if (dateQualified) payload.dateQualified = true;
      }
      const schemaId = await client.createPropertySchema(payload);
      if (contextClassId !== undefined) {
        // Class context: bind the schema to the class, then the optional
        // binding-level default (the v2 correction — defaults are binding
        // configuration, never schema fields).
        const bindings = client.getClassBindings(contextClassId);
        await client.setClassProperty(contextClassId, schemaId, {
          sequence: bindings.length,
          ...(defaultValue !== null &&
          defaultValue !== "" &&
          defaultCapable(type)
            ? { defaultValue: coerceDefault(type, defaultValue, options) }
            : {}),
        });
      }
      onCreated?.(schemaId, type);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  // Enter anywhere inside the modal = create (capture phase, v1 parity).
  // Portaled pickers own their Enter/Escape; the icon picker popup too.
  // Refs keep the listener on the latest handler without re-registering.
  const canCreateRef = useRef(canCreate);
  canCreateRef.current = canCreate;
  const handleCreateRef = useRef(handleCreate);
  handleCreateRef.current = handleCreate;
  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement;
      if (!target.closest(".nt-property-create")) return;
      if (target.closest(".icon-picker-popup, .node-selector, button")) return;
      event.preventDefault();
      event.stopPropagation();
      if (canCreateRef.current) void handleCreateRef.current();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Create property"
      size="md"
      className="nt-property-create"
      footer={
        <div className="modal__footer">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canCreate} onClick={() => void handleCreate()}>
            {busy ? "Creating…" : "Create Property"}
          </Button>
        </div>
      }
    >
      <div className="modal__content">
        {/* Name + icon (v1's name row: the icon trigger left of the field). */}
        <PropertyField label="Name">
          <div className="nt-property-create__name-row">
            <IconTriggerButton
              buttonRef={iconButtonRef}
              icon={icon}
              label="Choose icon"
              onClick={() => setIconPickerOpen((open) => !open)}
            />
            <input
              ref={nameInputRef}
              type="text"
              className="nt-property-settings__input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Property name"
              aria-label="Property name"
              aria-invalid={nameError !== null}
              autoFocus
            />
            {iconPickerOpen && (
              <IconPickerPopup
                value={icon ?? ""}
                anchorEl={iconButtonRef.current}
                onClose={() => setIconPickerOpen(false)}
                onSelect={(value) => {
                  setIcon(value === "" ? null : value);
                  setIconPickerOpen(false);
                }}
              />
            )}
          </div>
          {nameError !== null && (
            <p className="nt-property-create__error" role="alert">
              {nameError}
            </p>
          )}
        </PropertyField>

        {/* Type grid — the radiogroup (arrow-key navigable, v1 parity). */}
        <PropertyField label="Type">
          <div className="nt-property-create__type-grid" role="radiogroup" aria-label="Property type">
            {PROPERTY_TYPE_OPTIONS.map((option, index) => {
              const selected = type === option.type;
              return (
                <button
                  key={option.type}
                  ref={(el) => {
                    typeOptionRefs.current[index] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  className={
                    selected
                      ? "nt-property-create__type nt-property-create__type--selected"
                      : "nt-property-create__type"
                  }
                  onClick={() => handleTypeChange(option.type)}
                  onKeyDown={(event) => {
                    const count = PROPERTY_TYPE_OPTIONS.length;
                    let next = index;
                    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % count;
                    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + count) % count;
                    else if (event.key === "Home") next = 0;
                    else if (event.key === "End") next = count - 1;
                    else return;
                    event.preventDefault();
                    const nextType = PROPERTY_TYPE_OPTIONS[next]!;
                    handleTypeChange(nextType.type);
                    typeOptionRefs.current[next]?.focus();
                  }}
                >
                  <span className="nt-property-create__type-label">{option.label}</span>
                  <span className="nt-property-create__type-description">{option.description}</span>
                </button>
              );
            })}
          </div>
        </PropertyField>

        {/* Single/multi (multi-capable types; multi_select is always multi). */}
        {multiEligible && (
          <PropertyField label="Values">
            <SelectionButton
              size="sm"
              aria-label="Values"
              options={[
                { value: "single", icon: "mdi-numeric-1", label: "Single value" },
                { value: "multi", icon: "mdi-numeric-9-plus", label: "Multiple values" },
              ]}
              value={multi ? "multi" : "single"}
              onChange={(value) => setMulti(value === "multi")}
            />
          </PropertyField>
        )}

        {/* Options (the selection family). */}
        {(type === "select" || type === "multi_select") && (
          <PropertyOptionsEditor options={options} onChange={setOptions} />
        )}

        {/* Target classes (node-typed schemas). */}
        {FILTERED_TYPES.has(type) && (
          <PropertyField label="Target classes">
            <ClassMultiPickField
              client={client}
              classIds={targetClassIds}
              onChange={setTargetClassIds}
              addLabel="Add target class"
              ariaLabel="Target classes"
            />
            <span className="nt-property-create__hint">
              Values must link a node carrying one of these classes (empty = any node).
            </span>
          </PropertyField>
        )}

        {/* Date behavior. */}
        {type === "datetime" && (
          <>
            <PropertyField label="Precision">
              <select
                className="nt-property-settings__input"
                aria-label="Date precision"
                value={datePrecision}
                onChange={(event) =>
                  setDatePrecision(event.target.value as "day" | "month" | "year")
                }
              >
                <option value="day">Day</option>
                <option value="month">Month</option>
                <option value="year">Year</option>
              </select>
            </PropertyField>
            <label className="nt-property-settings__check">
              <input
                type="checkbox"
                checked={dateQualified}
                onChange={(event) => setDateQualified(event.target.checked)}
                aria-label="Date range qualifiers"
              />
              <span>Allow start/end qualifiers</span>
            </label>
          </>
        )}

        {/* Scope — the sole locality authority (R1). */}
        <PropertyScopeControl
          client={client}
          local={scopeLocal}
          classIds={scopeClassIds}
          onLocalChange={setScopeLocal}
          onClassIdsChange={setScopeClassIds}
        />
        {scopeLocal && scopeClassIds.length === 0 && (
          <p className="nt-property-create__hint" role="alert">
            Pick at least one class — the empty scope is rejected.
          </p>
        )}

        {/* Default value — class context only (defaults are binding-level). */}
        {contextClassId !== undefined && defaultCapable(type) && (
          <PropertyField label="Default value for new members (optional)">
            {type === "boolean" ? (
              <SelectionButton
                size="sm"
                aria-label="Default value"
                options={[
                  { value: "", icon: "mdi-close", label: "None" },
                  { value: "true", icon: "mdi-check", label: "Checked" },
                  { value: "false", icon: "mdi-circle-outline", label: "Unchecked" },
                ]}
                value={defaultValue ?? ""}
                onChange={(value) => setDefaultValue(value === "" ? null : value)}
              />
            ) : type === "select" ? (
              <select
                className="nt-property-settings__input"
                aria-label="Default value"
                value={defaultValue ?? ""}
                onChange={(event) =>
                  setDefaultValue(event.target.value === "" ? null : event.target.value)
                }
              >
                <option value="">None</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={type === "number" ? "number" : "text"}
                className="nt-property-settings__input"
                value={defaultValue ?? ""}
                onChange={(event) => setDefaultValue(event.target.value)}
                placeholder="Default value"
                aria-label="Default value"
              />
            )}
          </PropertyField>
        )}

        {error !== null && (
          <p className="nt-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** Coerce the staged default text into the schema-typed binding value (PC2 —
 *  class.property.set validates it at apply time and fails loud). */
function coerceDefault(
  type: string,
  raw: string,
  _options: ClientPropertyOption[],
): unknown {
  if (type === "number") return Number(raw);
  if (type === "boolean") return raw === "true";
  return raw;
}
