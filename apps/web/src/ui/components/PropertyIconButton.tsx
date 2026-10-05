/**
 * PropertyIconButton — §34.89 design, §34.90 contracts: a select-typed or
 * boolean property whose SCHEMA carries a "bullet"/"inline" display position
 * rides the block row as an icon button
 * (the Logseq-DB "UI position: beginning of the block" behavior; the v1
 * PropertyIconButton port). The button shows the FIRST selected option's MDI
 * icon tinted with its color — the at-a-glance state read; an unset value
 * renders a dimmed hollow circle so a fresh task can be given a value in
 * place. Clicking opens a small popover listing every option (icon + label +
 * checkmark) to change the value; multi_select toggles per click,
 * single-select and boolean replace, and a "None" row clears when the
 * binding is not required. Booleans carry two synthetic options (the
 * owner-specified glyphs): true = check-circle tinted green, false = hollow
 * circle tinted gray.
 *
 * Read-only projections render the icon without the button behavior (no
 * popover). Options without an icon render the label-less tinted dot
 * fallback — the button always mounts for display-configured properties so
 * the hit target stays uniform.
 */

import { useRef, useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { EffectiveProperty, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { cssColorFor } from "./ui/colorPresets.js";
import { usePopupDismissal } from "./ui/usePopupDismissal.js";
import type { SelectionOption } from "./pickers/SelectionPropertyControl.js";
import "./PropertyIconButton.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** §34.89 boolean mode: the owner-specified synthetic options — the checked
 *  circle (green) for true, the hollow circle (gray) for false. The option
 *  ids are the JSON boolean spelled out; writes translate back. */
const BOOLEAN_TRUE_OPTION: SelectionOption = {
  id: "true",
  label: "True",
  icon: "mdiCheckCircle",
  color: "green",
};
const BOOLEAN_FALSE_OPTION: SelectionOption = {
  id: "false",
  label: "False",
  icon: "mdiCircleOutline",
  color: "gray",
};

/** The selected option ids of one effective row (single id, or the legacy
 *  array shape — the effective projection splits multi elements into rows,
 *  but archived rows may still carry an array). Mirrors SelectPropertyRow. */
function valuesOf(row: EffectiveProperty): string[] {
  return Array.isArray(row.value)
    ? row.value.filter((v): v is string => typeof v === "string")
    : typeof row.value === "string" && row.value !== ""
      ? [row.value]
      : [];
}

/** The option glyph: its MDI icon tinted with the option color, or the
 *  tinted/neutral dot when the option declares no icon. */
function OptionGlyph({ option, size = 0.7 }: { option: SelectionOption | undefined; size?: number }) {
  if (option?.icon) {
    return (
      <Icon
        path={option.icon}
        size={size}
        {...(option.color ? { color: cssColorFor(option.color) } : {})}
      />
    );
  }
  return (
    <span
      className="nt-propicon__dot"
      style={option?.color ? { background: cssColorFor(option.color) } : undefined}
      aria-hidden="true"
    />
  );
}

export interface PropertyIconButtonProps {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  /** Property display name (the tooltip prefix). */
  label: string;
  /** The schema's select options (ignored in boolean mode — the two
   *  synthetic true/false options replace them). */
  options: ReadonlyArray<SelectionOption>;
  /** The property's effective rows on this node — the per-element idxs drive
   *  the multi toggles (multi_select values are separate rows per element). */
  rows: ReadonlyArray<EffectiveProperty>;
  multi: boolean;
  required: boolean;
  /** Boolean mode: the value is the JSON boolean at idx 0, rendered/written
   *  through the synthetic check-circle / hollow-circle options. */
  boolean?: boolean;
  /** Read-only projection: the icon renders but never opens the popover. */
  disabled?: boolean;
}

export function PropertyIconButton({
  client,
  nodeId,
  propertySchemaId,
  label,
  options,
  rows,
  multi,
  required,
  boolean = false,
  disabled = false,
}: PropertyIconButtonProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Dismissal (§34.67): Escape from outside + pointer-down outside; the
  // popover root owns an interior Escape.
  usePopupDismissal({
    popupRef: popoverRef,
    anchorRefs: [buttonRef],
    isOpen: open && !disabled,
    onClose: () => setOpen(false),
  });

  const ordered = [...rows].sort((a, b) => a.idx - b.idx);
  // Boolean mode reads the JSON boolean at the first row (BooleanPropertyRow's
  // shape) and maps it onto the synthetic true/false options; select modes
  // read option ids.
  const firstValue: unknown = ordered[0]?.value;
  const currentBoolean: boolean | null =
    boolean && typeof firstValue === "boolean" ? firstValue : null;
  const selectedIds = boolean
    ? currentBoolean === null
      ? []
      : [currentBoolean ? BOOLEAN_TRUE_OPTION.id : BOOLEAN_FALSE_OPTION.id]
    : ordered.flatMap(valuesOf);
  const currentOption = boolean
    ? currentBoolean === true
      ? BOOLEAN_TRUE_OPTION
      : currentBoolean === false
        ? BOOLEAN_FALSE_OPTION
        : undefined
    : options.find((option) => option.id === selectedIds[0]);
  const displayOptions = boolean ? [BOOLEAN_TRUE_OPTION, BOOLEAN_FALSE_OPTION] : options;
  const tooltip =
    currentOption !== undefined ? `${label}: ${currentOption.label}` : `${label}: none`;

  const choose = async (optionId: string): Promise<void> => {
    if (boolean) {
      await client.setProperty(nodeId, propertySchemaId, optionId === "true", 0);
      setOpen(false);
      return;
    }
    if (multi) {
      // The store validates multi_select values as option-id ARRAYS per idx
      // (SelectPropertyRow's write shape): toggle off within the carrying
      // row's array, toggle on by merging into the first row's array.
      const row = ordered.find((r) => valuesOf(r).includes(optionId));
      if (row !== undefined) {
        const remaining = valuesOf(row).filter((id) => id !== optionId);
        if (remaining.length > 0) {
          await client.setProperty(nodeId, propertySchemaId, remaining, row.idx);
        } else {
          await client.unsetProperty(nodeId, propertySchemaId, row.idx);
        }
      } else {
        const merged = [...selectedIds.filter((id) => id !== optionId), optionId];
        await client.setProperty(nodeId, propertySchemaId, merged, ordered[0]?.idx ?? 0);
      }
      // The popover stays open so several values can toggle in one pass.
      return;
    }
    await client.setProperty(nodeId, propertySchemaId, optionId, 0);
    setOpen(false);
  };

  const clear = async (): Promise<void> => {
    await client.unsetProperty(nodeId, propertySchemaId, 0);
    setOpen(false);
  };

  const glyph =
    selectedIds.length === 0 ? (
      <Icon path="mdiCircleOutline" size={0.7} />
    ) : (
      <OptionGlyph option={currentOption} />
    );

  if (disabled) {
    return (
      <span
        className={`nt-propicon nt-propicon--static${selectedIds.length === 0 ? " nt-propicon--unset" : ""}`}
        title={tooltip}
        data-property-schema-id={propertySchemaId}
      >
        {glyph}
      </span>
    );
  }

  return (
    <span className="nt-propicon-wrap">
      <button
        ref={buttonRef}
        type="button"
        className={`nt-propicon${selectedIds.length === 0 ? " nt-propicon--unset" : ""}`}
        title={tooltip}
        aria-label={tooltip}
        aria-haspopup="menu"
        aria-expanded={open}
        data-property-schema-id={propertySchemaId}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((prev) => !prev);
        }}
      >
        {glyph}
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="nt-propicon-popover"
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {displayOptions.length === 0 && <div className="nt-propicon-popover__empty">No options.</div>}
          {displayOptions.map((option) => {
            const selected = selectedIds.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                role="menuitem"
                className={
                  selected
                    ? "nt-propicon-option nt-propicon-option--selected"
                    : "nt-propicon-option"
                }
                onClick={() => void choose(option.id)}
              >
                <span className="nt-propicon-option__glyph">
                  <OptionGlyph option={option} />
                </span>
                <span className="nt-propicon-option__label">{option.label}</span>
                {selected && (
                  <span className="nt-propicon-option__check" aria-hidden="true">
                    <Icon path="mdi-check" size={0.55} />
                  </span>
                )}
              </button>
            );
          })}
          {!required && selectedIds.length > 0 && (
            <button
              type="button"
              role="menuitem"
              className="nt-propicon-option nt-propicon-option--none"
              onClick={() => void clear()}
            >
              <span className="nt-propicon-option__glyph">
                <Icon path="mdiCircleOutline" size={0.7} />
              </span>
              <span className="nt-propicon-option__label">None</span>
            </button>
          )}
        </div>
      )}
    </span>
  );
}
