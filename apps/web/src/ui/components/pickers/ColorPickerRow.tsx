/**
 * ColorPickerRow — inline color picker row for the pill context menu.
 *
 * Renders the node color palette as swatches; the first entry clears the
 * color. Extracted as its own component so node pickers can offer the
 * color-swatch row without pulling in the full context menu.
 */

import { useMemo } from "react";

import { NODE_PICKER_PALETTE } from "./nodeColors.js";
import "./ColorPickerRow.css";

interface ColorPickerRowProps {
  currentColor: string | null;
  onColorChange: (color: string | null) => void;
  className?: string;
}

export function ColorPickerRow({ currentColor, onColorChange, className = "" }: ColorPickerRowProps) {
  const nodeColors = useMemo<(string | null)[]>(() => NODE_PICKER_PALETTE, []);

  const handleColorClick = (e: React.MouseEvent, color: string | null) => {
    e.stopPropagation();
    e.preventDefault();
    onColorChange(color);
  };

  return (
    <div role="group" aria-label="Color options" className={`context-menu-color-row ${className}`}>
      <span className="context-menu-color-label">Color</span>
      <div className="context-menu-color-swatches">
        {nodeColors.map((color) => (
          <button
            key={color || "none"}
            className={`context-menu-color-swatch ${currentColor === color ? "selected" : ""} ${!color ? "no-color" : ""}`}
            style={color ? { backgroundColor: color } : undefined}
            onClick={(e) => handleColorClick(e, color)}
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            title={color || "No color"}
          >
            {!color && <span className="context-menu-color-swatch-line" />}
          </button>
        ))}
      </div>
    </div>
  );
}
