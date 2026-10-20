import { useRef, useState } from "react";

import { type DatePrecision } from "@notees/domain";

import type {
  ClientValidationRules,
  PropertyDisplay,
} from "@/core/workspace-client/index.js";

import { Icon } from "../../ui/Icon.js";
import { IconPickerPopup } from "../icon-picker/IconPickerPopup.js";
import { Modal } from "../../components/ui/fleet/Modal.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { ToggleSwitch } from "../../components/ui/fleet/ToggleSwitch.js";
import { SelectionButton } from "../../components/ui/fleet/SelectionButton.js";
import { ConfirmationModal } from "../../components/ui/fleet/ConfirmationModal.js";
import { PropertyConvertModal } from "./PropertyConvertModal.js";
import { PropertyDeleteModal } from "./PropertyDeleteModal.js";
import { PropertyOptionsEditor } from "./PropertyOptionsEditor.js";
import { PropertyScopeControl } from "./PropertyScopeControl.js";
import { ClassMultiPickField, PropertyField } from "./ClassMultiPickField.js";
import type { AnyClient } from "./shared.js";

/**
 * PropertySettingsModal (S2, the property-definition surfaces batch) — the
 * property's BASE-DEFINITION editor, grown from the settings modal (the
 * per-label entry in the properties table stays). v1 PropertyView's config
 * section port 1:1, adapted to the v2 wire (the owner-2026-10-20 update
 * fields) and the fleet kit:
 *
 *  - rename + icon (update {icon}, the keep/clear contract);
 *  - type read-only + "Convert…" → PropertyConvertModal (R6-gated inside);
 *  - multi toggle (update {multi}; a multi→single narrowing with values
 *    anywhere shows v1's danger confirm — the UI owns the warning, the
 *    applier does not police existing values);
 *  - options editor (select/multi_select: add/remove/reorder, icon+color);
 *  - targetClassFilter editing (update {targetClassFilter} — now writable);
 *  - scope control (update {scopeClassIds}, null = global — the sole
 *    locality authority, R1);
 *  - number formats (pad/decimals/rounding, display-only);
 *  - date precision + dateQualified;
 *  - the render contracts (display/readonly/hideWhenEmpty — moved in from
 *    the original settings modal, unchanged);
 *  - validationRules editors (v1 parity: number min/max, text/url/email
 *    pattern — the regex must compile before the write lands);
 *  - Delete — the standalone flow (v1's confirmation copy), the same modal
 *    the PropertyView footer opens.
 *
 * Every field writes through patch() → client.updatePropertySchema on
 * blur/change (absent keeps, present-null clears).
 */
export function PropertySettingsModal({
  client,
  propertySchemaId,
  onClose,
  onOpenView,
}: {
  client: AnyClient;
  propertySchemaId: string;
  onClose: () => void;
  onOpenView: () => void;
}) {
  const schema = client.listPropertySchemas().find((s) => s.id === propertySchemaId);
  const [convertOpen, setConvertOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  /** The multi→single danger confirm (v1 parity — values anywhere). */
  const [multiConfirmOpen, setMultiConfirmOpen] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const iconButtonRef = useRef<HTMLButtonElement | null>(null);
  /** The pattern editor's local error (a regex that does not compile). */
  const [patternError, setPatternError] = useState<string | null>(null);
  /** The scope toggle's optimistic local state: flipping to "local" reveals
   *  the picker BEFORE any write (a local scope with no classes can't ride
   *  the wire — the empty list is rejected); the write lands on the first
   *  pick. Flipping off writes null (global) immediately. */
  const [scopeLocal, setScopeLocal] = useState(schema?.scopeClassIds !== null);
  if (schema === undefined) return null;

  const patch = (fields: Parameters<AnyClient["updatePropertySchema"]>[1]) =>
    void client.updatePropertySchema(propertySchemaId, fields);

  const hasValues = client.getPropertyReferences(propertySchemaId).length > 0;

  /** The CURRENT stored rules — read at write time so two blur writes in one
   *  render cycle don't clobber each other (the render-captured object is
   *  stale between the store write and the re-render). */
  const currentRules = (): ClientValidationRules =>
    client.listPropertySchemas().find((s) => s.id === propertySchemaId)?.validationRules ?? {};

  const handleMultiChange = (next: boolean) => {
    if (schema.multi && !next && hasValues) {
      setMultiConfirmOpen(true);
      return;
    }
    patch({ multi: next });
  };

  const saveValidationRules = (rules: ClientValidationRules | null) =>
    patch({ validationRules: rules });

  return (
    <Modal isOpen onClose={onClose} size="md" showCloseButton={false} className="nt-property-settings">
      <div className="modal__header">
        <h2 className="modal__title">Property settings</h2>
        <Button icon="mdi mdi-close" aria-label="Close modal" className="modal__close" onClick={onClose} size="sm" variant="ghost" />
      </div>
      <div className="modal__content">
        {/* Name + icon (the base definition's identity). */}
        <PropertyField label="Name">
          <div className="nt-property-create__name-row">
            <button
              ref={iconButtonRef}
              type="button"
              className="nt-property-settings__option-icon"
              title="Choose icon"
              aria-label="Choose icon"
              onClick={() => setIconPickerOpen((open) => !open)}
            >
              {schema.icon !== null && schema.icon !== "" ? (
                <Icon path={schema.icon} size={0.7} />
              ) : (
                <Icon path="mdi-plus-circle-outline" size={0.7} />
              )}
            </button>
            <input
              key={schema.id}
              type="text"
              className="nt-property-settings__input"
              defaultValue={schema.name}
              aria-label="Property name"
              onBlur={(event) => {
                const name = event.target.value.trim();
                if (name !== "" && name !== schema.name) patch({ name });
              }}
            />
            {iconPickerOpen && (
              <IconPickerPopup
                value={schema.icon ?? ""}
                anchorEl={iconButtonRef.current}
                onClose={() => setIconPickerOpen(false)}
                onSelect={(value) => {
                  patch({ icon: value === "" ? null : value });
                  setIconPickerOpen(false);
                }}
              />
            )}
          </div>
        </PropertyField>

        {/* Type — a create-time contract: read-only + the R6-gated Convert. */}
        <PropertyField label="Type">
          <div className="nt-property-create__name-row">
            <span className="nt-property-settings__meta">
              {schema.type}
              {schema.multi ? " (multi)" : ""}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setConvertOpen(true)}>
              Convert…
            </Button>
          </div>
        </PropertyField>

        {/* Single/multi (update {multi} — the owner-2026-10-20 field). */}
        <PropertyField label="Values">
          <SelectionButton
            size="sm"
            aria-label="Values"
            options={[
              { value: "single", icon: "mdi-numeric-1", label: "Single value" },
              { value: "multi", icon: "mdi-numeric-9-plus", label: "Multiple values" },
            ]}
            value={schema.multi ? "multi" : "single"}
            onChange={(value) => handleMultiChange(value === "multi")}
          />
        </PropertyField>

        {/* Value display — select / multi_select / boolean types only (the
            block-row button register; the render contract is property-level). */}
        {(schema.type === "select" || schema.type === "multi_select" || schema.type === "boolean") && (
          <PropertyField label="Value display">
            <SelectionButton
              size="sm"
              aria-label="Value display"
              options={[
                { value: "panel", icon: "mdi-format-list-bulleted-square", label: "Properties panel" },
                { value: "bullet", icon: "mdi-circle-medium", label: "Next to bullet" },
                { value: "inline", icon: "mdi-format-align-left", label: "Before content" },
              ]}
              value={schema.display ?? "panel"}
              onChange={(value) => patch({ display: value as PropertyDisplay })}
            />
          </PropertyField>
        )}

        <PropertyField label="Read-only">
          <ToggleSwitch
            id="property-readonly"
            size="sm"
            leftLabel="Editable"
            rightLabel="Read-only"
            checked={schema.readonly === true}
            onChange={(value) => patch({ readonly: value ? true : null })}
            aria-label="Read-only"
          />
        </PropertyField>
        <PropertyField label="Hide when empty">
          <ToggleSwitch
            id="property-hide-when-empty"
            size="sm"
            leftLabel="Always show"
            rightLabel="Hide when empty"
            checked={schema.hideWhenEmpty === true}
            onChange={(value) => patch({ hideWhenEmpty: value ? true : null })}
            aria-label="Hide when empty"
          />
        </PropertyField>

        {/* Validation rules (v1 parity): min/max on number,
            pattern on text/url/email — the regex must compile first. */}
        {schema.type === "number" && (
          <PropertyField label="Validation">
            <div className="nt-property-create__name-row">
              <input
                type="number"
                className="nt-property-settings__input"
                key={`min:${schema.validationRules?.min ?? ""}`}
                defaultValue={schema.validationRules?.min ?? ""}
                placeholder="No min"
                aria-label="Minimum value"
                onBlur={(event) => {
                  const raw = event.target.value.trim();
                  const next: ClientValidationRules = { ...currentRules() };
                  if (raw === "") delete next.min;
                  else next.min = Number(raw);
                  if (next.min !== undefined && next.max !== undefined && next.min > next.max) return;
                  saveValidationRules(Object.keys(next).length > 0 ? next : null);
                }}
              />
              <input
                type="number"
                className="nt-property-settings__input"
                key={`max:${schema.validationRules?.max ?? ""}`}
                defaultValue={schema.validationRules?.max ?? ""}
                placeholder="No max"
                aria-label="Maximum value"
                onBlur={(event) => {
                  const raw = event.target.value.trim();
                  const next: ClientValidationRules = { ...currentRules() };
                  if (raw === "") delete next.max;
                  else next.max = Number(raw);
                  if (next.min !== undefined && next.max !== undefined && next.min > next.max) return;
                  saveValidationRules(Object.keys(next).length > 0 ? next : null);
                }}
              />
            </div>
            <span className="nt-property-create__hint">
              Values outside the range are rejected when set.
            </span>
          </PropertyField>
        )}
        {(schema.type === "text" || schema.type === "url" || schema.type === "email") && (
          <PropertyField label="Validation pattern">
            <input
              type="text"
              className="nt-property-settings__input"
              key={`pattern:${schema.validationRules?.pattern ?? ""}`}
              defaultValue={schema.validationRules?.pattern ?? ""}
              placeholder={schema.type === "url" ? "https?://.*" : schema.type === "email" ? ".+@.+\\..+" : "Regex pattern"}
              aria-label="Validation pattern"
              aria-invalid={patternError !== null}
              onBlur={(event) => {
                const raw = event.target.value.trim();
                const next: ClientValidationRules = { ...currentRules() };
                if (raw === "") {
                  delete next.pattern;
                  setPatternError(null);
                } else {
                  try {
                    new RegExp(raw);
                    next.pattern = raw;
                    setPatternError(null);
                  } catch {
                    setPatternError("This pattern is not a valid regular expression.");
                    return;
                  }
                }
                saveValidationRules(Object.keys(next).length > 0 ? next : null);
              }}
            />
            {patternError !== null && (
              <p className="nt-property-create__error" role="alert">
                {patternError}
              </p>
            )}
          </PropertyField>
        )}

        {/* Number formats (display-only, SCHEMA.md "Number formats"). */}
        {schema.type === "number" && (
          <PropertyField label="Number format">
            <div className="nt-property-create__name-row">
              <input
                type="number"
                min={1}
                max={20}
                className="nt-property-settings__input"
                key={`pad:${schema.numberPad ?? ""}`}
                defaultValue={schema.numberPad ?? ""}
                placeholder="Pad (off)"
                aria-label="Zero-pad digits"
                onBlur={(event) => {
                  const raw = event.target.value.trim();
                  const value = raw === "" ? null : Math.max(1, Math.min(20, Math.trunc(Number(raw))));
                  if (value === (schema.numberPad ?? null)) return;
                  patch({ numberPad: value });
                }}
              />
              <input
                type="number"
                min={0}
                max={10}
                className="nt-property-settings__input"
                key={`decimals:${schema.numberDecimals ?? ""}`}
                defaultValue={schema.numberDecimals ?? ""}
                placeholder="Decimals (as stored)"
                aria-label="Decimal digits"
                onBlur={(event) => {
                  const raw = event.target.value.trim();
                  const value = raw === "" ? null : Math.max(0, Math.min(10, Math.trunc(Number(raw))));
                  if (value === (schema.numberDecimals ?? null)) return;
                  patch({ numberDecimals: value });
                }}
              />
              <select
                className="nt-property-settings__input"
                aria-label="Rounding mode"
                value={schema.numberRounding ?? "round"}
                onChange={(event) =>
                  patch({
                    numberRounding: event.target.value as "round" | "floor" | "ceil" | "truncate",
                  })
                }
              >
                <option value="round">Round</option>
                <option value="floor">Floor</option>
                <option value="ceil">Ceiling</option>
                <option value="truncate">Truncate</option>
              </select>
            </div>
          </PropertyField>
        )}

        {schema.type === "datetime" && (
          <>
            <PropertyField label="Precision">
              <select
                className="nt-property-settings__input"
                aria-label="Date precision"
                value={schema.datePrecision ?? "day"}
                onChange={(event) =>
                  patch({ datePrecision: event.target.value as DatePrecision })
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
                checked={schema.dateQualified ?? false}
                onChange={(event) => patch({ dateQualified: event.target.checked })}
                aria-label="Date range qualifiers"
              />
              <span>Allow start/end qualifiers</span>
            </label>
          </>
        )}

        {/* Options (the selection family). */}
        {(schema.type === "select" || schema.type === "multi_select") && (
          <PropertyOptionsEditor
            options={schema.options ?? []}
            onChange={(options) => patch({ options })}
          />
        )}

        {/* Target classes — now writable (update {targetClassFilter}). */}
        {(schema.type === "object" || schema.type === "asset" || schema.type === "datetime") && (
          <PropertyField label="Target classes">
            <ClassMultiPickField
              client={client}
              classIds={schema.targetClassFilter ?? []}
              onChange={(classIds) => patch({ targetClassFilter: classIds })}
              addLabel="Add target class"
              ariaLabel="Target classes"
            />
            <span className="nt-property-create__hint">
              Values must link a node carrying one of these classes (empty = any node).
            </span>
          </PropertyField>
        )}

        {/* Scope — the sole locality authority (R1); null = global. The
            toggle carries optimistic local state: "local" reveals the picker
            before any write (an empty list is rejected); the write lands on
            the first pick; flipping off writes null (global). */}
        <PropertyScopeControl
          client={client}
          local={scopeLocal}
          classIds={schema.scopeClassIds ?? []}
          onLocalChange={(local) => {
            setScopeLocal(local);
            if (!local) patch({ scopeClassIds: null });
          }}
          onClassIdsChange={(classIds) => {
            setScopeLocal(true);
            patch({ scopeClassIds: classIds.length > 0 ? classIds : null });
          }}
        />
      </div>
      <div className="modal__footer">
        {/* Delete — the standalone flow (v1 copy), shared with the
            PropertyView footer. */}
        <Button variant="ghost" onClick={() => setDeleteOpen(true)}>
          Delete…
        </Button>
        <Button variant="ghost" onClick={onOpenView}>
          Open property
        </Button>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
      {convertOpen && (
        <PropertyConvertModal client={client} schema={schema} onClose={() => setConvertOpen(false)} />
      )}
      {deleteOpen && (
        <PropertyDeleteModal
          client={client}
          schema={schema}
          onClose={() => setDeleteOpen(false)}
          onDeleted={onClose}
        />
      )}
      {multiConfirmOpen && (
        <ConfirmationModal
          isOpen
          title="Change to Single Value"
          message="Changing this property to single-value will delete all extra values and keep only the first value for each node."
          secondaryMessage="This action cannot be undone. Are you sure you want to continue?"
          confirmLabel="Change to Single Value"
          cancelLabel="Cancel"
          variant="danger"
          onConfirm={() => {
            patch({ multi: false });
            setMultiConfirmOpen(false);
          }}
          onCancel={() => setMultiConfirmOpen(false)}
        />
      )}
    </Modal>
  );
}

/** The semantic name (S2's "base-definition editor") — the same component. */
export const PropertyEditModal = PropertySettingsModal;
