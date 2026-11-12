/**
 * FilterMenu — the `/`-mode options list of the command palette and the
 * node pickers: a section header over navigable option rows (leading icon,
 * label, one-line description). Purely presentational — the host owns the
 * keyboard model (the active row follows the host's single list index) and
 * swaps the option set (`filterModel.listFilterOptions` / `listClassOptions`).
 */

import { Icon } from '../../../ui/Icon.js';
import './FilterMenu.css';

export interface FilterMenuOption {
  /** Stable row id. */
  id: string;
  label: string;
  description: string;
  icon: string;
}

export interface FilterMenuProps {
  /** The section header ("Filters", or "Classes" in the class browse). */
  title: string;
  options: FilterMenuOption[];
  /** The host's active list index (arrow keys + hover drive it). */
  activeIndex: number;
  onSelect: (id: string) => void;
  onHover: (index: number) => void;
  /** Empty-list text (a picker mode with no applicable filters). */
  emptyText?: string;
  className?: string;
}

export function FilterMenu({
  title,
  options,
  activeIndex,
  onSelect,
  onHover,
  emptyText = 'No filters available',
  className = '',
}: FilterMenuProps) {
  return (
    <div className={`filter-menu ${className}`.trim()} role="listbox" aria-label={title}>
      <div className="filter-menu__title">{title}</div>
      {options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          data-active={index === activeIndex}
          className="filter-menu__row"
          onClick={() => onSelect(option.id)}
          onMouseEnter={() => onHover(index)}
        >
          <Icon path={option.icon} size={0.9} className="filter-menu__icon" />
          <span className="filter-menu__text">
            <span className="filter-menu__label">{option.label}</span>
            <span className="filter-menu__description">{option.description}</span>
          </span>
        </button>
      ))}
      {options.length === 0 && <div className="filter-menu__empty">{emptyText}</div>}
    </div>
  );
}
