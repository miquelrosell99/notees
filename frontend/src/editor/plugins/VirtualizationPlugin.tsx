/**
 * VirtualizationPlugin — Viewport-aware block mounting/unmounting.
 *
 * Observes which BlockNode DOM elements are visible in the viewport
 * using IntersectionObserver. Blocks outside the viewport are replaced
 * with lightweight placeholder divs that preserve scroll height.
 *
 * Architecture:
 * - Runtime is the source of truth — all blocks exist in the runtime
 *   regardless of visibility.
 * - Lexical tree always contains the full projection of BlockNodes
 *   (needed for keyboard navigation, search, undo). Content is
 *   populated only for visible blocks; off-screen blocks are empty
 *   shells with a CSS-enforced min-height to prevent scroll jumps.
 * - This plugin communicates visible block IDs to sibling plugins
 *   (BlockPropertyIconsPlugin, BlockClassPillsPlugin) via a shared
 *   context so they skip portal mounting for off-screen blocks.
 *
 * Performance characteristics:
 * - IO callback runs on compositor thread (non-blocking)
 * - Content population/depopulation batched in a single Lexical update
 * - Root margin provides 200px buffer above/below viewport to avoid
 *   flicker during scrolling
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type JSX,
} from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import {
  updateVisibleBlockIds as syncVisibleBlockIds,
  setVirtualizationEnabled,
  resetVirtualizedState,
} from '../virtualizedState';

// ─── Context ──────────────────────────────────────────────────────

interface VirtualizationState {
  /** Set of block IDs currently visible (or within root margin buffer) */
  visibleBlockIds: Set<string>;
  /** Whether virtualization is enabled */
  enabled: boolean;
}

const VirtualizationContext = createContext<VirtualizationState>({
  visibleBlockIds: new Set(),
  enabled: false,
});

export function useVirtualization(): VirtualizationState {
  return useContext(VirtualizationContext);
}

// ─── Constants ────────────────────────────────────────────────────

/** Blocks within this margin of the viewport are considered "visible" */
const ROOT_MARGIN = '400px 0px 400px 0px';

/**
 * Minimum number of blocks before virtualization kicks in.
 * Below this threshold, all blocks are rendered normally.
 * Lowered from 80 to 30 to help with pages that have many blocks.
 */
const VIRTUALIZATION_THRESHOLD = 30;

/**
 * Placeholder height for off-screen blocks (approximate line height).
 * Blocks measure their actual height before being depopulated, so this
 * is only a fallback for blocks never measured.
 */
const DEFAULT_BLOCK_HEIGHT = 28;

// ─── Plugin ───────────────────────────────────────────────────────

export interface VirtualizationPluginProps {
  /** Disable virtualization (always mount all blocks) */
  disabled?: boolean;
  children: React.ReactNode;
}

export function VirtualizationPlugin({
  disabled = false,
  children,
}: VirtualizationPluginProps): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [visibleBlockIds, setVisibleBlockIds] = useState<Set<string>>(new Set());
  const [totalBlocks, setTotalBlocks] = useState(0);

  // Map blockId → last measured height (for placeholder sizing)
  const measuredHeights = useRef(new Map<string, number>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const observedElements = useRef(new Set<Element>());

  // Track whether the IntersectionObserver has fired at least once
  // for the current observer instance.  Until it has, we skip CSS
  // virtualization to prevent a flash of blank blocks when
  // virtualization first enables or the page switches.
  const hasIOReported = useRef(false);

  // Track block IDs from the previous editor update so we can detect
  // page switches (no overlap → reset IO tracking).
  const prevBlockIdsRef = useRef(new Set<string>());

  // Determine if virtualization should be active
  const enabled = !disabled && totalBlocks >= VIRTUALIZATION_THRESHOLD;

  // Sync enabled state to shared module
  useEffect(() => {
    setVirtualizationEnabled(enabled);
  }, [enabled]);

  // Reset shared state on unmount
  useEffect(() => {
    return () => { resetVirtualizedState(); };
  }, []);

  // ─── Track total block count ─────────────────────────────

  useEffect(() => {
    const updateCount = () => {
      editor.getEditorState().read(() => {
        const root = $getRoot();
        let count = 0;
        const currentBlockIds = new Set<string>();
        for (const child of root.getChildren()) {
          if ($isBlockNode(child)) {
            count++;
            currentBlockIds.add(child.getBlockId());
          }
        }
        setTotalBlocks(count);

        // Detect page switch: if the current blocks have no overlap
        // with the previous set, visible IDs are stale.  Clear them
        // and reset IO tracking so CSS virtualization is deferred
        // until the observer reports for the new elements.
        const prev = prevBlockIdsRef.current;
        if (prev.size > 0 && currentBlockIds.size > 0) {
          let hasOverlap = false;
          for (const id of currentBlockIds) {
            if (prev.has(id)) { hasOverlap = true; break; }
          }
          if (!hasOverlap) {
            hasIOReported.current = false;
            setVisibleBlockIds(new Set());
          }
        }
        prevBlockIdsRef.current = currentBlockIds;
      });
    };

    updateCount();

    return editor.registerUpdateListener(({ dirtyElements }) => {
      if (dirtyElements.size > 0) {
        updateCount();
      }
    });
  }, [editor]);

  // ─── IntersectionObserver management ─────────────────────

  const handleIntersection = useCallback((entries: IntersectionObserverEntry[]) => {
    hasIOReported.current = true;
    setVisibleBlockIds(prev => {
      const next = new Set(prev);
      let changed = false;

      for (const entry of entries) {
        const blockId = (entry.target as HTMLElement).dataset.blockId;
        if (!blockId) continue;

        if (entry.isIntersecting) {
          if (!next.has(blockId)) {
            next.add(blockId);
            changed = true;
          }
        } else {
          if (next.has(blockId)) {
            // Measure height before removing from visible set
            const rect = entry.boundingClientRect;
            if (rect.height > 0) {
              measuredHeights.current.set(blockId, rect.height);
            }
            next.delete(blockId);
            changed = true;
          }
        }
      }

      return changed ? next : prev;
    });
  }, []);

  // Create/destroy observer based on enabled state
  useEffect(() => {
    if (!enabled) {
      observerRef.current?.disconnect();
      observerRef.current = null;
      observedElements.current.clear();
      return;
    }

    // Reset IO tracking — the new observer hasn't reported yet.
    hasIOReported.current = false;

    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    // Find the scrollable ancestor for the root option
    const scrollRoot = findScrollableAncestor(rootEl);

    observerRef.current = new IntersectionObserver(handleIntersection, {
      root: scrollRoot,
      rootMargin: ROOT_MARGIN,
      threshold: 0,
    });

    // Observe all existing block elements.
    // Do NOT initially mark all as visible — let the IO callback
    // determine true viewport intersection. This avoids populating
    // content for 600 blocks when only ~50 are on screen.
    const blockEls = rootEl.querySelectorAll('[data-block-id]');
    blockEls.forEach(el => {
      observerRef.current!.observe(el);
      observedElements.current.add(el);
    });

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      observedElements.current.clear();
    };
  }, [editor, enabled, handleIntersection]);

  // ─── Observe/unobserve as DOM mutates ────────────────────

  useEffect(() => {
    if (!enabled) return;

    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    const syncObservedElements = () => {
      const observer = observerRef.current;
      if (!observer) return;

      const currentEls = new Set(
        rootEl.querySelectorAll('[data-block-id]'),
      );

      // Unobserve removed elements
      for (const el of observedElements.current) {
        if (!currentEls.has(el)) {
          observer.unobserve(el);
          observedElements.current.delete(el);
        }
      }

      // Observe new elements
      for (const el of currentEls) {
        if (!observedElements.current.has(el)) {
          observer.observe(el);
          observedElements.current.add(el);
        }
      }
    };

    // Use MutationObserver to detect when Lexical adds/removes block elements
    const mutationObserver = new MutationObserver(() => {
      syncObservedElements();
    });

    mutationObserver.observe(rootEl, { childList: true, subtree: false });

    return () => {
      mutationObserver.disconnect();
    };
  }, [editor, enabled]);

  // ─── Apply virtualization: hide content of off-screen blocks

  useEffect(() => {
    // Don't apply until IO has reported which blocks are actually
    // in the viewport.  Before that, hiding would blank every block.
    if (!enabled || !hasIOReported.current) return;

    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    // Toggle CSS class on off-screen blocks for placeholder styling
    const blockEls = rootEl.querySelectorAll('[data-block-id]');
    blockEls.forEach(el => {
      const htmlEl = el as HTMLElement;
      const blockId = htmlEl.dataset.blockId;
      if (!blockId) return;

      const isVisible = visibleBlockIds.has(blockId);
      const wasVirtualized = htmlEl.classList.contains('node-block--virtualized');

      if (!isVisible && !wasVirtualized) {
        // Measure before virtualizing
        const height = htmlEl.offsetHeight;
        if (height > 0) {
          measuredHeights.current.set(blockId, height);
        }
        htmlEl.classList.add('node-block--virtualized');
        htmlEl.style.minHeight = `${measuredHeights.current.get(blockId) ?? DEFAULT_BLOCK_HEIGHT}px`;
      } else if (isVisible && wasVirtualized) {
        htmlEl.classList.remove('node-block--virtualized');
        htmlEl.style.minHeight = '';
      }
    });
  }, [editor, enabled, visibleBlockIds]);

  // ─── Sync visible IDs to shared module ─────────────────
  // Shared module is the bridge to BlockPlugin which cannot
  // consume React context (it is a sibling, not a child).
  useEffect(() => {
    syncVisibleBlockIds(visibleBlockIds);
  }, [visibleBlockIds]);

  // ─── Context value ──────────────────────────────────────

  const contextValue = useMemo<VirtualizationState>(() => ({
    visibleBlockIds,
    enabled,
  }), [visibleBlockIds, enabled]);

  return (
    <VirtualizationContext.Provider value={contextValue}>
      {children}
    </VirtualizationContext.Provider>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

function findScrollableAncestor(el: HTMLElement): HTMLElement | null {
  let current = el.parentElement;
  while (current) {
    const style = getComputedStyle(current);
    const overflow = style.overflowY;
    if (overflow === 'auto' || overflow === 'scroll') {
      return current;
    }
    current = current.parentElement;
  }
  return null; // Use viewport
}
