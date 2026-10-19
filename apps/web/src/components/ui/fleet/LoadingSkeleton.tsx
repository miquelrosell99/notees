/**
 * LoadingSkeleton - Shimmer placeholder for loading states
 *
 * Usage:
 *   <LoadingSkeleton rows={3} />
 *   <Skeleton shape="heading" width="3-4" />
 *   <Skeleton shape="circle" className="skeleton-row__avatar" />
 *
 * Thin fleet wrapper over the normalized catalog skeleton
 * (src/components/ui/skeleton.tsx): the fleet register is the loading
 * SHIMMER sweep (the catalog's pulse is swapped back for the fleet's
 * 200% gradient sweep on the skeleton tokens) and the shape/width row
 * model is the app's and lives here; every value resolves to a token
 * through the Tailwind config (the global `shimmer` keyframe lives in
 * variables.css).
 *
 * Legacy hook classes: `skeleton` / `skeleton--${shape}` /
 * `skeleton--${width}` and the group/row hooks stay on their elements —
 * tests and feature CSS compound on them.
 */
import type { CSSProperties } from 'react';

import { Skeleton as CatalogSkeleton } from '@/components/ui/skeleton.js';
import { cn } from './cn.js';

export type SkeletonShape = 'text' | 'heading' | 'circle' | 'rect' | 'card';
export type SkeletonWidth = 'full' | '3-4' | '2-3' | 'half' | '1-3' | '1-4';

export interface SkeletonProps {
  shape?: SkeletonShape;
  width?: SkeletonWidth;
  style?: CSSProperties;
  className?: string;
}

const SHAPE_CLASSES: Record<SkeletonShape, string> = {
  // The row heights ride the em-based skeleton tokens (adaptive — they
  // track the surrounding type metrics, per the adaptive-values law).
  text: 'skeleton--text h-skeleton-text rounded-shape-xs',
  heading: 'skeleton--heading h-skeleton-heading rounded-shape-xs',
  circle: 'skeleton--circle rounded-full',
  rect: 'skeleton--rect rounded-item',
  card: 'skeleton--card rounded-card',
};

const WIDTH_CLASSES: Record<SkeletonWidth, string> = {
  full: 'skeleton--full w-full',
  '3-4': 'skeleton--3-4 w-3-4',
  '2-3': 'skeleton--2-3 w-2-3',
  half: 'skeleton--half w-half',
  '1-3': 'skeleton--1-3 w-1-3',
  '1-4': 'skeleton--1-4 w-1-4',
};

/** Single skeleton element. */
export function Skeleton({
  shape = 'rect',
  width = 'full',
  style,
  className = '',
}: SkeletonProps) {
  return (
    <CatalogSkeleton
      aria-hidden="true"
      style={style}
      className={cn(
        'skeleton bg-shimmer bg-sweep-200 animate-shimmer',
        SHAPE_CLASSES[shape],
        WIDTH_CLASSES[width],
        className,
      )}
    />
  );
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
    <div className={cn('skeleton-group flex w-full flex-col gap-2', className)} role="status" aria-label="Loading…">
      {showHeading && (
        <Skeleton shape="heading" width="half" className="skeleton-group__heading mb-2" />
      )}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton-row flex w-full items-center gap-2">
          {showAvatar && <Skeleton shape="circle" className="skeleton-row__avatar h-icon-xl w-icon-xl shrink-0" />}
          <div className="skeleton-row__content skeleton-group flex-1">
            <Skeleton shape="text" width={i % 3 === 2 ? '2-3' : 'full'} />
          </div>
        </div>
      ))}
    </div>
  );
}
