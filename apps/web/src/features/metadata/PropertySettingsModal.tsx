import { useState } from "react";

import { type DatePrecision } from "@notees/domain";

import type { PropertyDisplay } from "@/core/workspace-client/index.js";

import { Icon } from "../../ui/Icon.js";
import { IconPickerPopup } from "../icon-picker/IconPickerPopup.js";
import { Modal } from "../../components/ui/fleet/Modal.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { SelectionButton } from "../../components/ui/fleet/SelectionButton.js";
import { ToggleSwitch } from "../../components/ui/fleet/ToggleSwitch.js";
import { ColorButton } from "../../components/ui/fleet/ColorButton.js";
import { cssColorFor } from "../../components/ui/fleet/colorPresets.js";
import { PropertyConvertModal } from "./PropertyConvertModal.js";
import type { AnyClient } from "./shared.js";

/**
 * PropertySettingsModal — the property's "page" for configuration (opened by
 * clicking a property label in the table). The schemas are registry rows,
 * so the configuration surface is this modal:
 * rename, per-type behavior (date precision / qualified, select options),
 * and the property-level render contracts (value display, read-
 * only, hide when empty), the single home for those. Type and multi are
 * create-time contracts and display read-only. The "Open property" footer
 * path surfaces the schema inspector (PropertyView): metadata,
 * bound classes, and the authored-value references.
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
  /** The option whose icon picker is open (+ its anchor button). */
  const [iconPickerFor, setIconPickerFor] = useState<{
    optionId: string;
    anchor: HTMLElement;
  } | null>(null);
  if (schema === undefined) return null;

  const patch = (fields: Parameters<AnyClient["updatePropertySchema"]>[1]) =>
    void client.updatePropertySchema(propertySchemaId, fields);

  return (
    <Modal isOpen onClose={onClose} size="sm" showCloseButton={false} className="nt-property-settings">
      <div className="modal__header">
        <h2 className="modal__title">Property settings</h2>
        <button type="button" aria-label="Close modal" className="btn btn--ghost btn--sm btn--icon-only modal__close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="modal__content">
        <label className="nt-property-settings__field">
          <span className="nt-property-settings__label">Name</span>
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
        </label>
        <p className="nt-property-settings__meta">
          Type: {schema.type}
          {schema.multi ? " (multi)" : ""}
        </p>
        {/* The render contracts are PROPERTY-level — the single home
            for editing them is this settings surface. Value display rides
            the types the block-row button renders (select / multi_select /
            boolean); read-only and hide-when-empty are type-agnostic. The
            wire stores "panel" / null explicitly. */}
        {(schema.type === "select" || schema.type === "multi_select" || schema.type === "boolean") && (
          <label className="nt-property-settings__field">
            <span className="nt-property-settings__label">Value display</span>
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
          </label>
        )}
        <label className="nt-property-settings__field">
          <span className="nt-property-settings__label">Read-only</span>
          <ToggleSwitch
            size="sm"
            leftLabel="Editable"
            rightLabel="Read-only"
            checked={schema.readonly === true}
            onChange={(value) => patch({ readonly: value ? true : null })}
            aria-label="Read-only"
          />
        </label>
        <label className="nt-property-settings__field">
          <span className="nt-property-settings__label">Hide when empty</span>
          <ToggleSwitch
            size="sm"
            leftLabel="Always show"
            rightLabel="Hide when empty"
            checked={schema.hideWhenEmpty === true}
            onChange={(value) => patch({ hideWhenEmpty: value ? true : null })}
            aria-label="Hide when empty"
          />
        </label>
        {schema.type === "datetime" && (
          <>
            <label className="nt-property-settings__field">
              <span className="nt-property-settings__label">Precision</span>
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
            </label>
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
        {schema.type === "select" && (
          <div className="nt-property-settings__field">
            <span className="nt-property-settings__label">Options</span>
            <ul className="nt-property-settings__options">
              {(schema.options ?? []).map((option) => (
                <li key={option.id} className="nt-property-settings__option">
                  {/* Per-option MDI icon (the picker's trash action
                      emits "" = clear; the wholesale options write preserves
                      ids like the ColorButton path above). */}
                  <button
                    type="button"
                    className="nt-property-settings__option-icon"
                    title={`Icon for ${option.label}`}
                    aria-label={`Icon for ${option.label}`}
                    onClick={(event) =>
                      setIconPickerFor({ optionId: option.id, anchor: event.currentTarget })
                    }
                  >
                    {option.icon ? (
                      <Icon
                        path={option.icon}
                        size={0.7}
                        {...(option.color ? { color: cssColorFor(option.color) } : {})}
                      />
                    ) : (
                      <Icon path="mdi-plus-circle-outline" size={0.7} />
                    )}
                  </button>
                  {/* Per-option color dot (the color grammar; none = uncolored). */}
                  <ColorButton
                    color={option.color ?? ""}
                    size="xs"
                    showPicker
                    showNoneOption
                    aria-label={`Color for ${option.label}`}
                    onColorChange={(color) =>
                      patch({
                        options: (schema.options ?? []).map((o) =>
                          o.id === option.id ? { ...o, color } : o,
                        ),
                      })
                    }
                  />
                  <input
                    key={`${option.id}:${option.label}`}
                    type="text"
                    className="nt-property-settings__input"
                    defaultValue={option.label}
                    aria-label={`Option ${option.label}`}
                    onBlur={(event) => {
                      const label = event.target.value.trim();
                      if (label === "" || label === option.label) return;
                      patch({
                        options: (schema.options ?? []).map((o) =>
                          o.id === option.id ? { ...o, label } : o,
                        ),
                      });
                    }}
                  />
                  <button
                    type="button"
                    className="pill__right-button"
                    aria-label={`Remove option ${option.label}`}
                    onClick={() =>
                      patch({
                        options: (schema.options ?? []).filter((o) => o.id !== option.id),
                      })
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                patch({
                  options: [
                    ...(schema.options ?? []),
                    { id: crypto.randomUUID(), label: "New option" },
                  ],
                })
              }
            >
              + Add option
            </Button>
            {iconPickerFor !== null && (
              <IconPickerPopup
                value={
                  schema.options?.find((option) => option.id === iconPickerFor.optionId)?.icon ??
                  ""
                }
                anchorEl={iconPickerFor.anchor}
                onClose={() => setIconPickerFor(null)}
                onSelect={(value) =>
                  patch({
                    options: (schema.options ?? []).map((option) =>
                      option.id === iconPickerFor.optionId
                        ? { ...option, icon: value === "" ? null : value }
                        : option,
                    ),
                  })
                }
              />
            )}
          </div>
        )}
      </div>
      <div className="modal__footer">
        {/* PG3: the blessed delete+recreate conversion flow (one honest
            flow — Capacities-style keep-original machinery is NOT built). */}
        <Button variant="ghost" onClick={() => setConvertOpen(true)}>
          Convert…
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
    </Modal>
  );
}
