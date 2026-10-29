/**
 * MoreActions — the toolbar's secondary-action overflow: a "⋮ More actions"
 * ghost button whose anchored panel lists the secondary items (icon + label
 * rows). The tier vocabulary mirrors the view registry's SelectionButton:
 * primary actions ride the bar inline, secondary actions ride this panel —
 * a bar never accumulates low-frequency utilities (export et al.) inline.
 *
 * Composed from ButtonWithPanel (the anchored-panel seam: focus trap,
 * Escape/outside dismissal, arrow-key row navigation via the data-menu-item
 * hook, optional portal). Empty items render nothing — a host with no
 * secondary actions contributes no chrome. Rows close the panel on select.
 */

import { Icon } from "../../../ui/Icon.js";
import { ButtonWithPanel } from "./ButtonWithPanel.js";
import "./MoreActions.css";

export interface MoreActionsItem {
  /** Stable item id. */
  id: string;
  /** MDI icon path. */
  icon: string;
  /** Row label (the panel shows icon + label, the trigger only "⋮"). */
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MoreActionsProps {
  items: MoreActionsItem[];
  /** Panel drop direction (default bottom, end-aligned under the trigger). */
  panelPosition?: "left" | "right" | "top" | "bottom";
  className?: string;
}

export function MoreActions({ items, panelPosition = "bottom", className = "" }: MoreActionsProps) {
  if (items.length === 0) return null;
  return (
    <ButtonWithPanel
      icon="mdi mdi-dots-vertical"
      variant="ghost"
      size="sm"
      panelPosition={panelPosition}
      panelAlignment="end"
      panelWidth="min(78vw, 22ch)"
      showCloseButton={false}
      tooltip="More actions"
      aria-label="More actions"
      buttonClassName={className}
    >
      {(closePanel) => (
        <div className="more-actions" role="menu" aria-label="More actions">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              data-menu-item
              className="more-actions__row"
              disabled={item.disabled}
              onClick={() => {
                closePanel();
                item.onSelect();
              }}
            >
              <Icon path={item.icon} size={0.8} className="more-actions__icon" />
              <span className="more-actions__label">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </ButtonWithPanel>
  );
}
