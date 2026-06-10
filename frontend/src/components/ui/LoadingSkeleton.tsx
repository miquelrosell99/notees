/**
 * LoadingSkeleton - Shimmer placeholder for loading states
 *
 * Usage:
 *   <LoadingSkeleton rows={3} />
 *   <Skeleton shape="heading" width="3-4" />
 *   <Skeleton shape="circle" style={{ width: 32, height: 32 }} />
 */
import type { CSSProperties } from 'react';
import './LoadingSkeleton.css';

export type SkeletonShape = 'text' | 'heading' | 'circle' | 'rect' | 'card';
export type SkeletonWidth = 'full' | '3-4' | '2-3' | 'half' | '1-3' | '1-4';

export interface SkeletonProps {
  shape?: SkeletonShape;
  width?: SkeletonWidth;
  style?: CSSProperties;
  className?: string;
}

/** Single skeleton element. */
export function Skeleton({
  shape = 'rect',
  width = 'full',
  style,
  className = '',
}: SkeletonProps) {
  const classes = [
    'skeleton',
    `skeleton--${shape}`,
    `skeleton--${width}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return <div className={classes} style={style} aria-hidden="true" />;
}

export interface LoadingSkeletonProps {
  /** Number of skeleton text rows to render */
  rows?: number;
  /** Show a heading skeleton before the text rows */
  showHeading?: boolean;
  /** Show an avatar/circle before each row */
  showAvatar?: boolean;
  /** className for the outer wrapper */
  className?: string;
}

/**
 * Pre-built skeleton pattern for common "list of items" loading state.
 * Renders a configurable number of shimmer rows.
 */
export function LoadingSkeleton({
  rows = 3,
  showHeading = false,
  showAvatar = false,
  className = '',
}: LoadingSkeletonProps) {
  return (
    <div className={`skeleton-group ${className}`} role="status" aria-label="Loading…">
      {showHeading && (
        <Skeleton shape="heading" width="half" style={{ marginBottom: '0.5rem' }} />
      )}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton-row">
          {showAvatar && (
            <Skeleton
              shape="circle"
              style={{ width: 32, height: 32, flexShrink: 0 }}
            />
          )}
          <div className="skeleton-group" style={{ flex: 1 }}>
            <Skeleton shape="text" width={i % 3 === 2 ? '2-3' : 'full'} />
          </div>
        </div>
      ))}
    </div>
  );
}
