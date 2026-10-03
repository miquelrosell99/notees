/**
 * ColorPickerRow — inline color picker row for the pill context menu.
 *
 * Renders the node color palette as swatches; the first entry clears the
 * color (object.update color: null — §34.43 grammar). Extracted as its own
 * component so node pickers can offer the color-swatch row without pulling
 * in the full context menu.
 */

import { useMemo } from "react";

import { PRESET_COLOR_ENTRIES, canonicalColor, cssColorFor } from "../ui/colorPresets.js";
import "./ColorPickerRow.css";

interface ColorPickerRowProps {
  currentColor: string | null;
  onColorChange: (color: string | null) => void;
  className?: string;
}

export function ColorPickerRow({ currentColor, onColorChange, className = "" }: ColorPickerRowProps) {
  const current = useMemo(
    () => (currentColor !== null ? canonicalColor(currentColor) : null),
    [currentColor],
  );

  const handleColorClick = (e: React.MouseEvent, color: string | null) => {
    e.stopPropagation();
    e.preventDefault();
    onColorChange(color);
  };

  return (
    <div role="group" aria-label="Color options" className={`context-menu-color-row ${className}`}>
      <span className="context-menu-color-label">Color</span>
      <div className="context-menu-color-swatches">
        <button
          key="none"
          className={`context-menu-color-swatch no-color ${current === null ? "selected" : ""}`}
          onClick={(e) => handleColorClick(e, null)}
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          title="No color"
        >
          <span className="context-menu-color-swatch-line" />
        </button>
        {PRESET_COLOR_ENTRIES.map(({ value, label }) => (
          <button
            key={value}
            className={`context-menu-color-swatch ${current === value ? "selected" : ""}`}
            style={{ backgroundColor: cssColorFor(value) }}
            onClick={(e) => handleColorClick(e, value)}
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            title={label}
          />
        ))}
      </div>
    </div>
  );
}
