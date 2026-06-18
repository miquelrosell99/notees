/**
 * PageViewHeader — reusable header chrome for pseudo-page views.
 *
 * Replaces ad-hoc `.page-header-section` / `.page-header` markup in list/hub
 * views so each view owns its own header styling instead of reaching into
 * NodeView / PageHeader internals.
 */
import type { ReactNode } from 'react';
import './PageViewHeader.css';

export interface PageViewHeaderProps {
  /** Main title (usually an <h1> or icon + text). */
  title?: ReactNode;
  /** Optional middle content, e.g. a search box. */
  middle?: ReactNode;
  /** Right-side actions. */
  actions?: ReactNode;
  /** Additional CSS class for per-view overrides. */
  className?: string;
}

export function PageViewHeader({ title, middle, actions, className = '' }: PageViewHeaderProps) {
  return (
    <header className={`page-view-header ${className}`}>
      {title && <div className="page-view-header__title">{title}</div>}
      {middle && <div className="page-view-header__middle">{middle}</div>}
      {actions && <div className="page-view-header__actions">{actions}</div>}
    </header>
  );
}
