/**
 * ListRow — the fleet list item: a 44px-min row with a 32px leading slot,
 * primary/secondary text lines, and a trailing affordance slot. Hover and
 * press ride the state-layer overlays; the active row carries a 3px accent
 * marker on the leading edge. Renders as a <button> when onClick is given
 * (the whole row is the hit area), else a <div>.
 *
 * The register follows the skill's ListRow template
 * (rosellramos-design-system, assets/templates/ListRow.css.template) with
 * the app's §7 recipe for the primary line: 14px/600 on the app type
 * scale — the exact values the seven feature stylesheets this component
 * was extracted from already agreed on (fleet audit 2026-10-26,
 * TEMPLATE-GAP finding: the only fleet-owned template with no app
 * component; its register was copy-pasted across pickers/NodeResultItem,
 * page-sections/{ActivityLog,Comments,VersionHistory}, trash/TrashHub,
 * classview/TaskBuckets, sharing/SharesHub, collection/FilterBlockBuilder).
 */

import { forwardRef, type ReactNode } from 'react';

import { cn } from './cn.js';
import './ListRow.css';

export interface ListRowProps {
  /** Leading slot — icon/avatar/checkbox. Rendered in the 32px slot. */
  leading?: ReactNode;
  /** The primary line (14px/600, ellipsis). */
  primary: ReactNode;
  /** Optional secondary line (11px, on-surface-variant, ellipsis). */
  secondary?: ReactNode;
  /** Trailing affordance — metadata, actions, pills. */
  trailing?: ReactNode;
  /** The active row — the 3px accent marker on the leading edge. */
  active?: boolean;
  disabled?: boolean;
  /** Whole-row click handler; presence turns the row into a button. */
  onClick?: (() => void) | undefined;
  className?: string;
  'aria-label'?: string | undefined;
  'aria-current'?: boolean | undefined;
  title?: string | undefined;
}

export const ListRow = forwardRef<HTMLButtonElement & HTMLDivElement, ListRowProps>(
  function ListRow(
    { leading, primary, secondary, trailing, active = false, disabled, onClick, className, ...props },
    ref,
  ) {
    const classes = cn(
      'list-row',
      active && 'list-row--active',
      disabled && 'list-row--disabled',
      className,
    );
    const body = (
      <>
        {active && <span className="list-row__active-marker" aria-hidden="true" />}
        {leading !== undefined && leading !== null && (
          <span className="list-row__leading">{leading}</span>
        )}
        <span className="list-row__text">
          <span className="list-row__primary">{primary}</span>
          {secondary !== undefined && secondary !== null && (
            <span className="list-row__secondary">{secondary}</span>
          )}
        </span>
        {trailing !== undefined && trailing !== null && (
          <span className="list-row__trailing">{trailing}</span>
        )}
      </>
    );
    if (onClick !== undefined) {
      return (
        <button ref={ref} type="button" className={classes} onClick={onClick} disabled={disabled} {...props}>
          {body}
        </button>
      );
    }
    return (
      <div ref={ref} className={classes} {...props}>
        {body}
      </div>
    );
  },
);
