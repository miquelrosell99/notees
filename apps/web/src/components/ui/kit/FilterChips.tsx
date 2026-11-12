/**
 * FilterChips — the applied-filter token row (the `/`-mode filter chips of
 * the command palette and the node pickers). One removable Pill per filter:
 * leading kind/class icon, folded label, × to remove. Purely presentational —
 * the host owns the filter state (Backspace-removes-last lives in the host's
 * input keydown) and derives labels/icons from the search-filters model.
 */

import { Icon } from '../../../ui/Icon.js';
import { Pill } from './Pill.js';
import './FilterChips.css';

export interface FilterChipItem {
  /** Stable chip id (the filter key). */
  id: string;
  label: string;
  icon: string;
}

export interface FilterChipsProps {
  items: FilterChipItem[];
  onRemove: (id: string) => void;
  className?: string;
}

export function FilterChips({ items, onRemove, className = '' }: FilterChipsProps) {
  if (items.length === 0) return null;
  return (
    <div className={`filter-chips ${className}`.trim()} role="list" aria-label="Active filters">
      {items.map((item) => (
        <Pill
          key={item.id}
          className="filter-chips__pill"
          text={item.label}
          leftIcon={<Icon path={item.icon} size={0.75} />}
          rightIcon={<Icon path="mdi-close" size={0.75} />}
          onRightIconClick={() => onRemove(item.id)}
        />
      ))}
    </div>
  );
}
