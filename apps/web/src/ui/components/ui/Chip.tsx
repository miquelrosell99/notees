/**
 * Chip Component
 *
 * A small toggle pill: an icon+label button with an explicit on/off state
 * (the filter-family idiom — the graph's Visibility panel, group toggles).
 * Distinct from `Pill` (a status/removable label) and `SelectionButton`
 * (a multi-option segmented control): a Chip is ONE independent toggle.
 */

import { forwardRef, type MouseEvent, type ReactNode } from 'react';
import { Icon } from '../../Icon.js';
import './Chip.css';

export interface ChipProps {
  /** Whether the chip is in its active/pressed state. */
  active?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Optional leading icon (an MDI class string, e.g. "mdi mdi-eye"). */
  icon?: string;
  /** Accessible name when the chip is icon-only. */
  ariaLabel?: string;
  className?: string;
  children?: ReactNode;
}

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { active = false, onClick, icon, ariaLabel, className = '', children },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={`chip${active ? ' chip--on' : ''} ${className}`.trim()}
      aria-pressed={active}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {icon !== undefined && <Icon path={icon} size="0.9em" className="chip__icon" />}
      {children}
    </button>
  );
});
