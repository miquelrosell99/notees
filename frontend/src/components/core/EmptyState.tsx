/**
 * EmptyState - Standardized empty/zero-data state component
 *
 * Usage:
 *   <EmptyState
 *     icon={<TrashIcon size="lg" />}
 *     title="Trash is empty"
 *     description="Deleted pages appear here."
 *     actionLabel="Go to pages"
 *     onAction={() => navigate('/pages')}
 *   />
 */
import type { ReactNode } from 'react';
import { Button } from './Button';
import './EmptyState.css';

export interface EmptyStateProps {
  /** Icon element to display (e.g. <TrashIcon size="lg" />) */
  icon?: ReactNode;
  /** Primary heading */
  title: string;
  /** Supporting text */
  description?: string;
  /** Label for the optional CTA button */
  actionLabel?: string;
  /** Handler for the optional CTA button */
  onAction?: () => void;
  /** Additional className */
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  className = '',
}: EmptyStateProps) {
  return (
    <div className={`empty-state ${className}`} role="status">
      {icon && <div className="empty-state__icon">{icon}</div>}
      <h3 className="empty-state__title">{title}</h3>
      {description && <p className="empty-state__description">{description}</p>}
      {actionLabel && onAction && (
        <div className="empty-state__action">
          <Button variant="primary" size="md" onClick={onAction}>
            {actionLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
