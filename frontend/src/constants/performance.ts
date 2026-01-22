/**
 * PERFORMANCE GUARDRAILS
 * 
 * Hard limits and thresholds for performance-critical operations.
 * These values define when the app should degrade gracefully rather than
 * attempt to render/load everything.
 * 
 * IMPORTANT: These are ENFORCED limits, not suggestions. Components should
 * check these before rendering large datasets and show appropriate UI when
 * limits are exceeded.
 */

// ==================== Rendering Limits ====================

/**
 * Maximum number of blocks to render before requiring virtualization.
 * Beyond this, components MUST use virtualized rendering or pagination.
 */
export const MAX_VISIBLE_BLOCKS = 100;

/**
 * Maximum number of NodeView components that can be mounted simultaneously.
 * Prevents memory exhaustion from deep recursive rendering.
 */
export const MAX_NODEVIEW_DEPTH = 10;

/**
 * Maximum blocks to auto-expand in a single NodeView.
 * Beyond this, show "Load more" or collapse by default.
 */
export const MAX_AUTO_EXPANDED_BLOCKS = 50;

// ==================== Backlinks & References ====================

/**
 * Maximum backlinks to auto-render in LinkedReferences section.
 * Beyond this, show count and "Show all" button.
 */
export const MAX_AUTO_RENDERED_BACKLINKS = 20;

/**
 * Maximum inline link previews to load on a single page.
 * Prevents N+1 query explosion for link-heavy content.
 */
export const MAX_LINK_PREVIEWS = 30;

// ==================== Images & Media ====================

/**
 * Maximum image dimensions before lazy loading is required.
 * Images larger than this MUST use LazyImage component.
 */
export const IMAGE_LAZY_THRESHOLD_PX = 300;

/**
 * Maximum total image bytes to load eagerly per page.
 * Beyond this, defer loading until scroll.
 */
export const MAX_EAGER_IMAGE_BYTES = 1024 * 1024 * 2; // 2MB

/**
 * Viewport margin for lazy loading intersection observer.
 * Images within this margin of viewport will begin loading.
 */
export const LAZY_LOAD_MARGIN_PX = 200;

// ==================== Query & Data Loading ====================

/**
 * Stale time for node metadata (titles, flags, timestamps).
 * Metadata changes rarely and can be cached longer.
 */
export const METADATA_STALE_TIME_MS = 1000 * 60 * 10; // 10 minutes

/**
 * Stale time for full node content with children/backlinks.
 * Content changes more frequently.
 */
export const CONTENT_STALE_TIME_MS = 1000 * 60 * 2; // 2 minutes

/**
 * Maximum nodes to prefetch in background navigation.
 * Prevents excessive memory usage from aggressive prefetching.
 */
export const MAX_PREFETCH_NODES = 10;

/**
 * Debounce delay for search queries to prevent API spam.
 */
export const SEARCH_DEBOUNCE_MS = 300;

// ==================== Virtualization ====================

/**
 * Row height estimate for virtualized lists.
 * Used for scroll position calculations.
 */
export const VIRTUAL_ROW_HEIGHT_PX = 32;

/**
 * Overscan count for virtualized lists.
 * Number of items to render outside visible area.
 */
export const VIRTUAL_OVERSCAN = 5;

/**
 * Minimum items before virtualization kicks in.
 * Below this, render everything directly.
 */
export const VIRTUALIZATION_THRESHOLD = 50;

// ==================== Animation & Interaction ====================

/**
 * Maximum items to animate in a list.
 * Beyond this, disable enter/exit animations for performance.
 */
export const MAX_ANIMATED_ITEMS = 30;

/**
 * Delay before showing loading spinners.
 * Prevents flash of loading state for fast operations.
 */
export const LOADING_DELAY_MS = 200;

// ==================== Helper Functions ====================

/**
 * Check if a list exceeds the virtualization threshold
 */
export function shouldVirtualize(itemCount: number): boolean {
  return itemCount > VIRTUALIZATION_THRESHOLD;
}

/**
 * Check if backlinks should be collapsed by default
 */
export function shouldCollapseBacklinks(count: number): boolean {
  return count > MAX_AUTO_RENDERED_BACKLINKS;
}

/**
 * Check if animations should be disabled for a list
 */
export function shouldDisableAnimations(itemCount: number): boolean {
  return itemCount > MAX_ANIMATED_ITEMS;
}

/**
 * Get safe slice of items respecting max visible limit
 */
export function getSafeSlice<T>(items: T[], max: number = MAX_VISIBLE_BLOCKS): T[] {
  return items.slice(0, max);
}
