/**
 * Inline color picker row for context menu.
 *
 * Extracted from NodeContextMenu to break the circular dependency
 * NodeRef → NodeContextMenu → NodeSelector → NodeRef.
 */
import { useMemo } from 'react';
import { getNodePickerPalette } from './views/viewTypes';
import './ColorPickerRow.css';

interface ColorPickerRowProps {
  currentColor: string | null;
  onColorChange: (color: string | null) => void;
}

export function ColorPickerRow({ currentColor, onColorChange }: ColorPickerRowProps) {
  const nodeColors = useMemo(() => getNodePickerPalette(), []);
  // Stop propagation to prevent ContextMenu's outside click handler from closing the menu
  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  const handleColorClick = (e: React.MouseEvent, color: string | null) => {
    e.stopPropagation();
    e.preventDefault();
    onColorChange(color);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.currentTarget.click();
        }
      }}
      className="context-menu-color-row"
      onMouseDown={handleMouseDown}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
    >
      <span className="context-menu-color-label">Color</span>
      <div className="context-menu-color-swatches">
        {nodeColors.map((color) => (
          <button
            key={color || 'none'}
            className={`context-menu-color-swatch ${currentColor === color ? 'selected' : ''} ${!color ? 'no-color' : ''}`}
            style={color ? { backgroundColor: color } : undefined}
            onClick={(e) => handleColorClick(e, color)}
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            title={color || 'No color'}
          >
            {!color && <span className="context-menu-color-swatch-line" />}
          </button>
        ))}
      </div>
    </div>
  );
}
