/**
 * SortMenuButton Component
 *
 * The sort-mode picker the collection views ride: a ghost icon button
 * (mdi-sort, the table Sort configurator's icon) opening a small panel of
 * named sort modes — one click selects AND closes. The option set is the
 * view's vocabulary (the list view offers Dates first / A–Z / Default
 * order, the cards view Last edited / A–Z); this component is value-agnostic
 * so the kit stays free of view-type imports.
 */

import { ButtonWithPanel } from "./ButtonWithPanel.js";
import { Icon } from "../../Icon.js";
import "./SortMenuButton.css";

export interface SortMenuOption {
  /** The mode id (selects the active row). */
  value: string;
  label: string;
  /** Optional trailing explanation (rides the row's far right). */
  hint?: string;
}

export interface SortMenuButtonProps {
  options: SortMenuOption[];
  value: string;
  onChange: (value: string) => void;
  tooltip?: string | undefined;
  disabled?: boolean | undefined;
}

export function SortMenuButton({ options, value, onChange, tooltip = "Sort", disabled = false }: SortMenuButtonProps) {
  return (
    <ButtonWithPanel
      icon="mdi-sort"
      variant="ghost"
      size="sm"
      panelPosition="bottom"
      panelAlignment="end"
      tooltip={tooltip}
      aria-label="Sort"
      disabled={disabled}
    >
      {(closePanel) => (
        <div className="sort-menu">
          <div className="sort-menu__title">Sort by</div>
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                className={`sort-menu__option${active ? " sort-menu__option--active" : ""}`.trim()}
                aria-pressed={active}
                onClick={() => {
                  onChange(option.value);
                  closePanel();
                }}
              >
                <Icon
                  path={active ? "mdi-check" : "mdi-sort"}
                  size={0.8}
                  className="sort-menu__check"
                />
                <span className="sort-menu__label">{option.label}</span>
                {option.hint !== undefined && <span className="sort-menu__hint">{option.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </ButtonWithPanel>
  );
}
