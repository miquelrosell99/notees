/**
 * SelectionPropertyControl — selection-type property value editor
 * (select / multi_select schemas with an options list).
 *
 * Selected options render as pills with a remove affordance; a "+"/"Empty"
 * trigger opens the options picker. Value ids reference the schema option
 * ids (single-select: one id; multi: an array). An option's optional
 * color tints its pill and shows as a dot in the picker;
 * an option's optional MDI icon renders before the label (tinted in
 * the picker, contrast-colored on the tinted pill).
 */

import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "../../Icon.js";
import { coloredPillStyle, cssColorFor } from "../ui/colorPresets.js";
import { usePopupDismissal } from "../ui/usePopupDismissal.js";
import { useViewportPosition } from "./useViewportPosition.js";
import "./PropertyCell.css";

export interface SelectionOption {
  id: string;
  label: string;
  /** Preset token / `#RRGGBB` hex; absent/null = uncolored. */
  color?: string | null;
  /** MDI icon name (camelCase); absent/null = no icon. */
  icon?: string | null;
}

interface SelectionPropertyControlProps {
  options: SelectionOption[];
  /** Selected option ids (single-select carries at most one). */
  values: string[];
  multi: boolean;
  disabled?: boolean;
  onAdd: (optionId: string) => void;
  onRemove: (optionId: string) => void;
}

export function SelectionPropertyControl({
  options,
  values,
  multi,
  disabled = false,
  onAdd,
  onRemove,
}: SelectionPropertyControlProps) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const cellRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // The picker portals to the body with viewport-fixed positioning: an
  // in-flow absolute popup inherits ancestor stacking contexts (sticky
  // section chrome, transformed rows) and page content bleeds through the
  // popup surface.
  const position = useViewportPosition(cellRef, isPickerOpen, {
    popupRef: pickerRef,
    edgePadding: 8,
  });

  // Dismissal: Escape closes; pointer-down outside the cell and picker
  // closes too (the trigger lives in the cell, so it must not self-dismiss).
  usePopupDismissal({
    popupRef: pickerRef,
    anchorRefs: [cellRef],
    isOpen: isPickerOpen,
    onClose: () => setIsPickerOpen(false),
  });

  const editable = !disabled;

  const resolvedOptions = values
    .map((value) => options.find((opt) => opt.id === value))
    .filter((opt): opt is SelectionOption => opt !== undefined);

  const handleAddOption = (option: SelectionOption) => {
    onAdd(option.id);
    setIsPickerOpen(false);
  };

  // The picker rides in a body portal (viewport-fixed); its option set
  // depends on the value state — every option from empty, only the
  // unselected ones otherwise.
  const pickerOptions =
    resolvedOptions.length === 0
      ? options
      : options.filter((opt) => !resolvedOptions.some((r) => r.id === opt.id));

  const picker = isPickerOpen ? (
    <>
      {createPortal(
        <div
          ref={pickerRef}
          className="property-cell__picker"
          style={{
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            visibility: position === null ? "hidden" : "visible",
          }}
        >
          {pickerOptions.length === 0 && (
            <div className="property-cell__picker-empty">No options.</div>
          )}
          {pickerOptions.map((option) => (
            <button
              type="button"
              key={option.id}
              className="property-cell__picker-option"
              onClick={() => handleAddOption(option)}
            >
              {option.icon && (
                <span className="property-cell__picker-icon">
                  <Icon
                    path={option.icon}
                    size={0.7}
                    {...(option.color ? { color: cssColorFor(option.color) } : {})}
                  />
                </span>
              )}
              <span
                className="property-cell__picker-dot"
                style={coloredPillStyle(option.color) ?? undefined}
                aria-hidden="true"
              />
              <span>{option.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  ) : null;

  // Empty state
  if (resolvedOptions.length === 0) {
    return (
      <div
        ref={cellRef}
        className={`property-cell property-cell--empty-wrapper ${editable ? "property-cell--editable" : ""}`}
      >
        <button
          type="button"
          className="property-cell property-cell--empty"
          onClick={() => editable && setIsPickerOpen((prev) => !prev)}
          title={editable ? "Click to select" : undefined}
          disabled={!editable}
        >
          <span className="property-placeholder">Empty</span>
        </button>
        {picker}
      </div>
    );
  }

  // Has values
  return (
    <div ref={cellRef} className="property-cell property-cell--selection">
      {resolvedOptions.map((option) => (
        <div key={option.id} className="pill" style={coloredPillStyle(option.color) ?? undefined}>
          {option.icon && (
            <span className="pill__left-icon">
              <Icon path={option.icon} size={0.7} />
            </span>
          )}
          <button
            type="button"
            className="pill__text"
            title={editable ? "Click to change" : undefined}
            onClick={() => editable && setIsPickerOpen((prev) => !prev)}
          >
            {option.label}
          </button>
          {editable && (
            <button
              type="button"
              className="pill__right-button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(option.id);
              }}
              aria-label={`Remove ${option.label}`}
            >
              <Icon path="mdi-close" size={0.55} />
            </button>
          )}
        </div>
      ))}
      {editable && multi && (
        <button
          type="button"
          onClick={() => setIsPickerOpen((prev) => !prev)}
          className="property-cell__add-button"
          aria-label="Add option"
        >
          +
        </button>
      )}
      {picker}
    </div>
  );
}
