/**
 * Lazy-loaded components for code splitting
 * 
 * These components are loaded on-demand to reduce initial bundle size.
 * Use these instead of direct imports for heavy/rarely-used components.
 */
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';

// Loading fallback component
function LoadingFallback({ height = 200 }: { height?: number }) {
  return (
    <div 
      style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        height,
        color: 'var(--text-muted)',
      }}
    >
      <span>Loading...</span>
    </div>
  );
}

/**
 * HOC to wrap lazy components with Suspense
 */
function withSuspense<P extends object>(
  LazyComponent: ComponentType<P>,
  fallbackHeight = 200
) {
  return function SuspenseWrapper(props: P) {
    return (
      <Suspense fallback={<LoadingFallback height={fallbackHeight} />}>
        <LazyComponent {...props} />
      </Suspense>
    );
  };
}

// === Heavy Components (lazy-loaded) ===

/** Graph visualization - heavy D3/force-graph dependency */
export const LazyNodeGraphView = withSuspense(
  lazy(() => import('@/components/graph/NodeGraphView').then(m => ({ default: m.NodeGraphView }))),
  400
);

/** Settings modal - rarely accessed */
export const LazySettingsModal = withSuspense(
  lazy(() => import('@/components/SettingsModal').then(m => ({ default: m.SettingsModal }))),
  300
);

/** Database management - admin feature */
export const LazyDatabaseManagementView = withSuspense(
  lazy(() => import('@/views/DatabaseManagementView').then(m => ({ default: m.DatabaseManagementView }))),
  400
);

/** Emoji picker - large dataset */
export const LazyEmojiPicker = withSuspense(
  lazy(() => import('@/components/core/EmojiPicker').then(m => ({ default: m.EmojiPicker }))),
  200
);

/** Calendar popup */
export const LazyCalendarPopup = withSuspense(
  lazy(() => import('@/components/core/CalendarPopup').then(m => ({ default: m.CalendarPopup }))),
  200
);

// === Utility for custom lazy loading ===

/**
 * Create a lazy-loaded component with custom fallback
 */
export function createLazyComponent<P extends object>(
  importFn: () => Promise<{ default: ComponentType<P> }>,
  fallback?: ReactNode
) {
  const LazyComponent = lazy(importFn);
  
  return function LazyWrapper(props: P) {
    return (
      <Suspense fallback={fallback ?? <LoadingFallback />}>
        <LazyComponent {...props} />
      </Suspense>
    );
  };
}
