/**
 * SurfaceTopBar — the in-card top bar for full-bleed hub surfaces: the NodeView's `.nt-node-topbar` register generalized into a
 * library primitive. A full-card-width row pinned above the surface's own
 * scrolling body: content cluster left (optional mdi icon + title + muted
 * count + freeform context), controls right. The hub views (Journal,
 * Calendar, Trash, Archived, Shares, the collection hubs, Search, Queries)
 * compose this instead of hand-rolled `__header` blocks so every hub's
 * chrome reads identically and the scroller underneath rides flush to the
 * card border.
 *
 * The actions cluster composes fleet Buttons (`variant="ghost" size="sm"`);
 * text actions like the journal's "Today" are Buttons with children, never
 * custom pills.
 *
 * Two additive extensions: `title` became OPTIONAL with a
 * freeform `lead` slot — the nodeview top bar (NodeTopbar, PageChrome.tsx)
 * composes this primitive with its own left cluster (the context-panel toggle
 * + the classes pills) instead of a hand-rolled row, so every in-card top bar
 * rides ONE element and ONE hairline register; and `className` passes through
 * to the root (the fleet Button precedent) so a host can carry its own
 * register overrides (the panelled page's padding-carrying override).
 * Two more: the `leading` cluster — the hub panel toggles
 * ride BEFORE the title, the general hub convention — and the `titleExtra`
 * slot, title-adjacent chrome (the Sources hub's count Badge).
 */

import type { ReactNode } from 'react';

import { Icon } from '../../../ui/Icon.js';
import './SurfaceTopBar.css';

export interface SurfaceTopBarProps {
  /**
   * Freeform cluster BEFORE the title block — the hub panel toggles ride
   * here (the general hub convention: panel toggles lead
   * the bar, left of the title, in every hub).
   */
  leading?: ReactNode;
  /** Optional mdi icon path rendered before the title. */
  icon?: string | undefined;
  /** The bar's heading; omit when `lead` carries the left cluster instead. */
  title?: string | undefined;
  /** Optional muted count after the title. */
  count?: number | undefined;
  /**
   * Optional extra content right after the title block (the Sources hub's
   * count Badge) — chrome, never a freeform fill; use `context` for that.
   */
  titleExtra?: ReactNode;
  /** Optional extra lead content after the title/count (e.g. a date line). */
  context?: ReactNode;
  /**
   * Freeform left-cluster content replacing the whole title block (the
   * nodeview top bar's toggle + classes pills). Wins over title/count/context.
   */
  lead?: ReactNode;
  /** Right-aligned control cluster. */
  actions?: ReactNode;
  /** Extra class merged onto the root (host register overrides). */
  className?: string | undefined;
}

export function SurfaceTopBar({
  leading,
  icon,
  title,
  count,
  titleExtra,
  context,
  lead,
  actions,
  className,
}: SurfaceTopBarProps) {
  return (
    <div className={["surface-topbar", className].filter(Boolean).join(" ")}>
      {leading !== undefined && <div className="surface-topbar__leading">{leading}</div>}
      {lead !== undefined ? (
        lead
      ) : (
        title !== undefined && (
          <h1 className="surface-topbar__title">
            {icon !== undefined && <Icon path={icon} size={1.1} />}
            {title}
          </h1>
        )
      )}
      {titleExtra !== undefined && <div className="surface-topbar__title-extra">{titleExtra}</div>}
      {lead === undefined && count !== undefined && <span className="surface-topbar__count">{count}</span>}
      {lead === undefined && context !== undefined && <div className="surface-topbar__context">{context}</div>}
      <span className="surface-topbar__spacer" aria-hidden="true" />
      {actions !== undefined && <div className="surface-topbar__actions">{actions}</div>}
    </div>
  );
}
