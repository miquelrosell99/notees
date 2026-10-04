/**
 * SelectionPropertyControl — selection-type property value editor
 * (select / multi_select schemas with an options list).
 *
 * Selected options render as pills with a remove affordance; a "+"/"Empty"
 * trigger opens the options picker. Value ids reference the schema option
 * ids (single-select: one id; multi: an array). PG16: an option's optional
 * color (§34.43 grammar) tints its pill and shows as a dot in the picker.
 */

import { useRef, useState } from "react";

import { Icon } from "../../Icon.js";
import { coloredPillStyle } from "../ui/colorPresets.js";
import { usePopupDismissal } from "../ui/usePopupDismissal.js";
import "./PropertyCell.css";

export interface SelectionOption {
  id: string;
  label: string;
  /** PG16: preset token / `#RRGGBB` hex; absent/null = uncolored. */
  color?: string | null;
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

  // Dismissal (§34.67): Escape closes; pointer-down outside the cell (which
  // hosts both the trigger and the picker) closes too.
  usePopupDismissal({
    popupRef: cellRef,
    isOpen: isPickerOpen,
    onClose: () => setIsPickerOpen(false),
  });

  const resolvedOptions = values
    .map((value) => options.find((opt) => opt.id === value))
    .filter((opt): opt is SelectionOption => opt !== undefined);

  const handleAddOption = (option: SelectionOption) => {
    onAdd(option.id);
    setIsPickerOpen(false);
  };

  const editable = !disabled;

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
        {isPickerOpen && (
          <div className="property-cell__picker">
            {options.length === 0 && <div className="property-cell__picker-empty">No options.</div>}
            {options.map((option) => (
              <button
                type="button"
                key={option.id}
                className="property-cell__picker-option"
                onClick={() => handleAddOption(option)}
              >
                <span
                  className="property-cell__picker-dot"
                  style={coloredPillStyle(option.color) ?? undefined}
                  aria-hidden="true"
                />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Has values
  return (
    <div ref={cellRef} className="property-cell property-cell--selection">
      {resolvedOptions.map((option) => (
        <div key={option.id} className="pill" style={coloredPillStyle(option.color) ?? undefined}>
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
      {isPickerOpen && (
        <div className="property-cell__picker">
          {options
            .filter((opt) => !resolvedOptions.some((r) => r.id === opt.id))
            .map((option) => (
              <button
                type="button"
                key={option.id}
                className="property-cell__picker-option"
                onClick={() => handleAddOption(option)}
              >
                <span
                  className="property-cell__picker-dot"
                  style={coloredPillStyle(option.color) ?? undefined}
                  aria-hidden="true"
                />
                <span>{option.label}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
