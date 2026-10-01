/**
 * NodePill — interactive node reference pill (the metadata picker's chip).
 *
 * A class/tag pill with an optional remove button and a right-click color
 * menu (the ported color-swatch row). Inline content rendering stays the
 * editor's job; this is the standalone pill used by the pickers.
 */

import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "../../Icon.js";
import type { ClientNode } from "@/core/workspace-client.js";
import { displayNameForSettings } from "../../dateDisplay.js";
import { ColorPickerRow } from "./ColorPickerRow.js";
import "./NodePill.css";

export interface NodePillProps {
  node: ClientNode;
  /** Callback when clicking the pill */
  onClick?: (() => void) | undefined;
  /** Callback when clicking the remove button */
  onRemove?: (() => void) | undefined;
  /** Callback when changing the color via the right-click menu */
  onColorChange?: ((color: string | null) => void) | undefined;
  /** Whether the pill is read-only (hides remove button and color change) */
  readOnly?: boolean;
  /** When true, the remove icon is hidden until the pill is hovered/focused. */
  rightIconHoverReveal?: boolean;
  className?: string;
}

export function NodePill({
  node,
  onClick,
  onRemove,
  onColorChange,
  readOnly = false,
  rightIconHoverReveal = false,
  className = "",
}: NodePillProps) {
  const [colorMenu, setColorMenu] = useState<{ x: number; y: number } | null>(null);
  const pillRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (readOnly || !onColorChange) return;
      e.preventDefault();
      e.stopPropagation();
      setColorMenu({ x: e.clientX, y: e.clientY });
    },
    [readOnly, onColorChange],
  );

  const closeColorMenu = useCallback(() => setColorMenu(null), []);

  // Title-is-content: the pill label is the node's display name (its content
  // excerpt); the id is the last-resort fallback so a pill never renders raw.
  const displayText = displayNameForSettings(node) || node.id;
  const title = `Page: ${displayText}\nRight-click for actions`;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        ref={pillRef}
        className={`node-pill ${className}`}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick?.();
          }
        }}
        onContextMenu={handleContextMenu}
        title={title}
        aria-label={title}
      >
        <div
          className={`pill ${rightIconHoverReveal ? "pill--hover-reveal-right" : ""}`}
          style={node.color ? { background: node.color } : undefined}
        >
          {node.icon !== null && (
            <span className="pill__left-icon">
              <Icon path={node.icon} size={0.55} />
            </span>
          )}
          <span className="pill__text">{displayText}</span>
          {!readOnly && onRemove && (
            <button
              type="button"
              className="pill__right-button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              aria-label="Remove"
            >
              <Icon path="mdi-close" size={0.55} />
            </button>
          )}
        </div>
      </div>

      {colorMenu && onColorChange && !readOnly && (
        <>
          {/* Backdrop to catch clicks outside */}
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop closes on click */}
          <div
            className="node-pill-context-menu-backdrop"
            style={{
              position: "fixed",
              inset: 0,
              zIndex: "var(--z-9998)",
            }}
            onClick={closeColorMenu}
          />
          {createPortal(
            <div
              className="node-pill-context-menu-wrapper"
              style={{
                position: "fixed",
                left: colorMenu.x,
                top: colorMenu.y,
                zIndex: "var(--z-9999)",
                display: "flex",
                flexDirection: "column",
              }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <ColorPickerRow
                currentColor={node.color ?? null}
                onColorChange={(color) => {
                  onColorChange(color);
                  closeColorMenu();
                }}
                className="node-pill-context-menu__color-row"
              />
            </div>,
            document.body,
          )}
        </>
      )}
    </>
  );
}
