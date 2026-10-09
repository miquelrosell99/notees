/**
 * GridMenu Component
 *
 * A menu of selectable action items laid out as a grid — the add-condition
 * popup's body, usable anywhere a chooser rides a popover. Items carry an
 * optional icon, a label and an optional description.
 *
 * Columns: a fixed count, or "auto" — auto fits as many columns as the
 * width allows (`repeat(auto-fill, minmax(...))`), so the menu expands with
 * its container instead of pinning a narrow single column.
 *
 * Keyboard navigation (ArrowUp/Down/Enter) rides the hosting popover's
 * [data-menu-item] contract (ButtonWithPanel); each item also carries
 * role="menuitem" for standalone menus.
 */

import { Icon } from "../../Icon.js";
import { cn } from "./cn.js";
import "./GridMenu.css";

export interface GridMenuItem {
  id: string;
  /** MDI icon path (e.g. "mdi-tag-outline"); omitted renders no icon. */
  icon?: string | undefined;
  label: string;
  description?: string | undefined;
  disabled?: boolean | undefined;
}

export interface GridMenuProps {
  items: GridMenuItem[];
  onSelect: (id: string) => void;
  /**
   * Column count, or "auto" to fit as many columns as the width allows
   * (expands with the container). Default 1 (a single column).
   */
  columns?: number | "auto" | undefined;
  /** Accessible name for the menu. */
  "aria-label"?: string | undefined;
  className?: string | undefined;
}

export function GridMenu({ items, onSelect, columns = 1, "aria-label": ariaLabel, className = "" }: GridMenuProps) {
  const gridClass =
    columns === "auto" ? "grid-menu--auto" : `grid-menu--${Math.max(1, Math.floor(columns))}`;
  return (
    <div className={cn("grid-menu", gridClass, className)} role="menu" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="grid-menu__item"
          data-menu-item
          disabled={item.disabled}
          onClick={() => onSelect(item.id)}
        >
          {item.icon !== undefined && (
            <Icon path={item.icon} size={0.8} className="grid-menu__icon" />
          )}
          <span className="grid-menu__text">
            <span className="grid-menu__label">{item.label}</span>
            {item.description !== undefined && (
              <span className="grid-menu__desc">{item.description}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
