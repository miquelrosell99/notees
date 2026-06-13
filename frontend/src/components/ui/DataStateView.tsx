/**
 * DataStateView - Unified loading/empty/error state wrapper
 *
 * Eliminates the inconsistent pattern of each view rolling its own
 * loading skeleton, empty message, and error display. Use this wrapper
 * around any async data-driven section.
 *
 * Usage:
 *   <DataStateView
 *     isLoading={isLoading}
 *     error={error}
 *     isEmpty={!data || data.length === 0}
 *     emptyTitle="No pages yet"
 *     emptyDescription="Create your first page to get started."
 *     emptyAction={{ label: 'Create page', onClick: handleCreate }}
 *     skeletonRows={5}
 *     onRetry={refetch}
 *   >
 *     {data.map(item => <Item key={item.id} {...item} />)}
 *   </DataStateView>
 */
import type { ReactNode } from 'react';
import { LoadingSkeleton } from './LoadingSkeleton';
import { EmptyState } from './EmptyState';
import { Button } from './Button';
import './DataStateView.css';

export interface DataStateViewProps {
  /** Whether data is being fetched */
  isLoading?: boolean;
  /** Error object if the fetch failed */
  error?: Error | unknown | null;
  /** Whether the fetched data is empty */
  isEmpty?: boolean;
  /** Skeleton rows to show while loading (default: 4) */
  skeletonRows?: number;
  /** Whether to show a heading skeleton */
  skeletonShowHeading?: boolean;
  /** Title for the empty state */
  emptyTitle?: string;
  /** Description for the empty state */
  emptyDescription?: string;
  /** Icon for the empty state */
  emptyIcon?: ReactNode;
  /** Optional CTA for the empty state */
  emptyAction?: { label: string; onClick: () => void };
  /** Custom empty state node (overrides emptyTitle/emptyDescription) */
  emptySlot?: ReactNode;
  /** Custom error title (default: 'Something went wrong') */
  errorTitle?: string;
  /** Callback to retry the failed request */
  onRetry?: () => void;
  /** Additional className on the wrapper */
  className?: string;
  /** Content to render when data is available and non-empty */
  children: ReactNode;
}

export function DataStateView({
  isLoading = false,
  error = null,
  isEmpty = false,
  skeletonRows = 4,
  skeletonShowHeading = false,
  emptyTitle = 'Nothing to show',
  emptyDescription,
  emptyIcon,
  emptyAction,
  emptySlot,
  errorTitle = 'Something went wrong',
  onRetry,
  className = '',
  children,
}: DataStateViewProps) {
  if (isLoading) {
    return (
      <div className={`data-state-view data-state-view--loading ${className}`} aria-busy="true">
        <LoadingSkeleton rows={skeletonRows} showHeading={skeletonShowHeading} />
      </div>
    );
  }

  if (error) {
    const message =
      error instanceof Error ? error.message : 'An unexpected error occurred.';
    return (
      <div className={`data-state-view data-state-view--error ${className}`} role="alert">
        <div className="data-state-view__error-icon">⚠</div>
        <h3 className="data-state-view__error-title">{errorTitle}</h3>
        <p className="data-state-view__error-message">{message}</p>
        {onRetry && (
          <Button variant="default" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    );
  }

  if (isEmpty) {
    if (emptySlot) {
      return (
        <div className={`data-state-view data-state-view--empty ${className}`}>
          {emptySlot}
        </div>
      );
    }
    return (
      <div className={`data-state-view data-state-view--empty ${className}`}>
        <EmptyState
          icon={emptyIcon}
          title={emptyTitle}
          description={emptyDescription}
          actionLabel={emptyAction?.label}
          onAction={emptyAction?.onClick}
        />
      </div>
    );
  }

  return <>{children}</>;
}
