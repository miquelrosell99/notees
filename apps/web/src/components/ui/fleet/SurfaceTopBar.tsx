/**
 * SurfaceTopBar — the in-card top bar for full-bleed hub surfaces (owner
 * 2026-10-22): the NodeView's `.nt-node-topbar` register generalized into a
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
 */

import type { ReactNode } from 'react';

import { Icon } from '../../../ui/Icon.js';
import './SurfaceTopBar.css';

export interface SurfaceTopBarProps {
  /** Optional mdi icon path rendered before the title. */
  icon?: string | undefined;
  title: string;
  /** Optional muted count after the title. */
  count?: number | undefined;
  /** Optional extra lead content after the title/count (e.g. a date line). */
  context?: ReactNode;
  /** Right-aligned control cluster. */
  actions?: ReactNode;
}

export function SurfaceTopBar({ icon, title, count, context, actions }: SurfaceTopBarProps) {
  return (
    <div className="surface-topbar">
      <h1 className="surface-topbar__title">
        {icon !== undefined && <Icon path={icon} size={1.1} />}
        {title}
      </h1>
      {count !== undefined && <span className="surface-topbar__count">{count}</span>}
      {context !== undefined && <div className="surface-topbar__context">{context}</div>}
      <span className="surface-topbar__spacer" aria-hidden="true" />
      {actions !== undefined && <div className="surface-topbar__actions">{actions}</div>}
    </div>
  );
}
