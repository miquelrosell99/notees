/**
 * Overlay hooks for the UI primitives kit.
 *
 * Local stand-ins for the app-level overlay infrastructure the legacy
 * components were wired to: a global input-context surface stack (Escape
 * handling in LIFO order), Floating UI positioning, and media-query hooks.
 * The behavior is reproduced here self-contained so the primitives work
 * standalone; an app integrating them may replace these with its own
 * global stack.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/* ==================== useOverlaySurface ==================== */

export type OverlaySurfaceType = 'modal' | 'popup';

interface OverlaySurface {
  id: string;
  close: () => void;
  onEscape: () => boolean | void;
}

/**
 * Module-level surface stack so Escape closes overlays in LIFO order when
 * several primitives are open at once (e.g. a Dropdown inside a Modal).
 */
const surfaceStack: OverlaySurface[] = [];
let escapeListenerInstalled = false;

function ensureEscapeListener(): void {
  if (escapeListenerInstalled || typeof document === 'undefined') return;
  escapeListenerInstalled = true;
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const top = surfaceStack[surfaceStack.length - 1];
    if (!top) return;
    if (top.onEscape() === true) return; // consumed by the surface (e.g. submenu)
    top.close();
  });
}

function generateSurfaceId(): string {
  return `surface-hook-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Observe element resizes where ResizeObserver is available (no-op in
 * environments without it, e.g. jsdom). Returns a disposer.
 */
export function observeResizes(
  elements: Array<HTMLElement | null | undefined>,
  callback: () => void,
): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  const observer = new ResizeObserver(callback);
  for (const el of elements) {
    if (el) observer.observe(el);
  }
  return () => observer.disconnect();
}

interface UseOverlaySurfaceOptions {
  /** Whether this surface should currently be registered on the stack. */
  enabled: boolean;
  /** Surface kind — kept for API parity; the local stack is kind-agnostic. */
  type: OverlaySurfaceType;
  /** Called when the stack decides this surface should close. */
  onClose: () => void;
  /**
   * Called before close when Escape is pressed.
   * Return true to consume Escape without closing (e.g. for nested sub-states).
   */
  onEscape?: (() => boolean | void) | undefined;
  /** Optional explicit id; one is generated if omitted. */
  id?: string | undefined;
}

/**
 * Register an overlay surface with the local surface stack.
 *
 * This lets a single Escape handler close surfaces in LIFO order,
 * regardless of where DOM focus currently is.
 */
export function useOverlaySurface(options: UseOverlaySurfaceOptions): string {
  const idRef = useRef(options.id ?? generateSurfaceId());
  const onCloseRef = useRef(options.onClose);
  const onEscapeRef = useRef(options.onEscape);

  useEffect(() => {
    onCloseRef.current = options.onClose;
    onEscapeRef.current = options.onEscape;
  });

  useEffect(() => {
    if (!options.enabled) return;

    ensureEscapeListener();

    const surface: OverlaySurface = {
      id: idRef.current,
      close: () => onCloseRef.current(),
      onEscape: () => onEscapeRef.current?.(),
    };
    surfaceStack.push(surface);

    return () => {
      const index = surfaceStack.indexOf(surface);
      if (index >= 0) surfaceStack.splice(index, 1);
    };
  }, [options.enabled, options.type]);

  return idRef.current;
}

/* ==================== useClickOutside ==================== */

/**
 * Hook to detect clicks outside one or more elements
 *
 * @param refs - Single ref or array of refs to exclude from "outside" detection
 * @param handler - Callback to invoke when clicking outside
 * @param enabled - Whether the listener is active (default: true)
 */
export function useClickOutside(
  refs: RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[],
  handler: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const refArray = Array.isArray(refs) ? refs : [refs];

      // Check if click is outside all provided refs
      const isOutside = refArray.every(
        (ref) => ref.current && !ref.current.contains(target),
      );

      if (isOutside) {
        handler();
      }
    };

    // Use mousedown instead of click for better UX (matches existing patterns)
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [refs, handler, enabled]);
}

/* ==================== useViewportFlip ==================== */

export interface ViewportFlipOptions {
  /** Maximum height of the popup (default: 300) */
  maxHeight?: number;
  /** Gap between anchor and popup (default: 4) */
  gap?: number;
  /** Include width from anchor rect in the result */
  includeWidth?: boolean;
  /** Minimum width override (popup will be at least this wide) */
  minWidth?: number;
  /**
   * Ref to the popup element. Required: the rendered popup is measured for
   * exact flip/shift decisions, and a ResizeObserver watches it for
   * resize-driven repositioning.
   */
  popupRef: RefObject<HTMLElement | null>;
  /**
   * Fixed-size mode: when set, skip the dynamic `maxHeight` computation and
   * just flip the popup as-is. The value itself is ignored — the rendered
   * popup is always measured.
   */
  popupHeight?: number;
  /** Horizontal/vertical edge padding when clamping (default: 16) */
  edgePadding?: number;
  /** Use fixed positioning coordinates (default: absolute/document coordinates) */
  fixed?: boolean;
}

export interface ViewportFlipResult {
  top: number;
  left: number;
  maxHeight?: number;
  width?: number;
}

/**
 * Positions a popup relative to an anchor element, flipping above when there
 * isn't enough space below and keeping it inside the viewport.
 *
 * Returns `null` until the first position is computed — consumers must render
 * the popup while open regardless (with `visibility: hidden` until positioned)
 * so it can be measured.
 *
 * Two modes:
 * - **Dynamic** (default): returns a `maxHeight` based on available viewport
 *   space. Used by Dropdown.
 * - **Fixed-size**: when `popupHeight` is provided, does a simple flip without
 *   a dynamic maxHeight.
 *
 * Positioning is tracked with scroll (window), viewport resize, and element
 * resize listeners; updates go through React state.
 */
export function useViewportFlip(
  anchorRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  options: ViewportFlipOptions,
): ViewportFlipResult | null {
  const {
    maxHeight: maxPopupHeight = 300,
    gap = 4,
    includeWidth = false,
    minWidth,
    popupRef,
    popupHeight,
    edgePadding = 16,
    fixed = false,
  } = options;

  const [position, setPosition] = useState<ViewportFlipResult | null>(null);

  useLayoutEffect(() => {
    const reference = anchorRef.current;
    const floating = popupRef?.current;
    if (!isOpen || !reference || !floating) {
      setPosition(null);
      return;
    }

    const update = () => {
      const rect = reference.getBoundingClientRect();
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const floatingW = floating.offsetWidth;
      const floatingH = floating.offsetHeight;

      const spaceBelow = viewportH - rect.bottom - gap - edgePadding;
      const spaceAbove = rect.top - gap - edgePadding;

      // Flip above when the popup does not fit below and there is more
      // room above (mirrors bottom-start -> top-start fallback).
      const fitsBelow = spaceBelow >= Math.min(floatingH, maxPopupHeight);
      const placeTop = !fitsBelow && spaceAbove > spaceBelow;

      let computedMaxHeight: number | undefined;
      let top: number;
      if (placeTop) {
        top = rect.top - gap - floatingH;
        if (popupHeight === undefined) {
          computedMaxHeight = Math.min(maxPopupHeight, Math.max(0, spaceAbove - gap));
        }
      } else {
        top = rect.bottom + gap;
        if (popupHeight === undefined) {
          computedMaxHeight = Math.min(maxPopupHeight, Math.max(0, spaceBelow - gap));
        }
      }

      // Shift into the viewport (cross-axis clamping).
      const effectiveH = computedMaxHeight !== undefined
        ? Math.min(floatingH, computedMaxHeight)
        : floatingH;
      top = Math.min(
        Math.max(top, edgePadding),
        Math.max(edgePadding, viewportH - effectiveH - edgePadding),
      );
      let left = rect.left;
      const effectiveW = includeWidth ? rect.width : floatingW;
      left = Math.min(
        Math.max(left, edgePadding),
        Math.max(edgePadding, viewportW - effectiveW - edgePadding),
      );

      if (!fixed) {
        // Absolute positioning at body level: coordinates are document-space.
        top += window.scrollY;
        left += window.scrollX;
      }

      const result: ViewportFlipResult = { top, left };
      if (computedMaxHeight !== undefined) result.maxHeight = computedMaxHeight;
      if (includeWidth) {
        const anchorWidth = rect.width;
        result.width = minWidth ? Math.max(anchorWidth, minWidth) : anchorWidth;
      }

      setPosition((prev) =>
        prev &&
        prev.top === result.top &&
        prev.left === result.left &&
        prev.maxHeight === result.maxHeight &&
        prev.width === result.width
          ? prev
          : result,
      );
    };

    update();

    const handleScroll = () => update();
    window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    window.addEventListener('resize', handleScroll);
    const unobserve = observeResizes([reference, floating], handleScroll);

    return () => {
      window.removeEventListener('scroll', handleScroll, { capture: true });
      window.removeEventListener('resize', handleScroll);
      unobserve();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- position depends on refs, not callback identity
  }, [isOpen, anchorRef, popupRef, maxPopupHeight, gap, includeWidth, minWidth, popupHeight, edgePadding, fixed]);

  return position;
}

/* ==================== useIsMobile ==================== */

function getMobileBreakpoint(): number {
  if (typeof window === 'undefined') return 768;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--breakpoint-tablet')
    .trim();
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : 768;
}

function supportsMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/**
 * Returns true when the viewport is at or below the mobile breakpoint.
 * Reads the breakpoint from `--breakpoint-tablet` in variables.css so
 * responsive logic stays in sync with the design tokens.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => supportsMatchMedia() && window.matchMedia(`(max-width: ${getMobileBreakpoint()}px)`).matches,
  );

  useEffect(() => {
    if (!supportsMatchMedia()) return;
    const mql = window.matchMedia(`(max-width: ${getMobileBreakpoint()}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}

/* ==================== useReducedMotion ==================== */

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Returns true when the user prefers reduced motion, as reported by
 * `prefers-reduced-motion: reduce`. Updates automatically if the preference
 * changes (e.g. on OS accessibility settings changes).
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (!supportsMatchMedia()) return false;
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  });

  useEffect(() => {
    if (!supportsMatchMedia()) return;
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    const handleChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, []);

  return reduced;
}

/* ==================== useFocusTrap ==================== */

/**
 * Selector for all focusable elements
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

interface UseFocusTrapOptions {
  /** Whether the focus trap is active (default: true) */
  enabled?: boolean;
  /** Called when Escape is pressed */
  onEscape?: (() => void) | undefined;
  /** Whether to auto-focus the first element on mount (default: true) */
  autoFocus?: boolean;
  /** Whether to restore focus on unmount (default: true) */
  restoreFocus?: boolean;
  /** Ref to element that should receive initial focus */
  initialFocusRef?: RefObject<HTMLElement | null> | undefined;
  /** Ref to element that should receive focus on close */
  finalFocusRef?: RefObject<HTMLElement | null> | undefined;
}

/**
 * Get all focusable elements within a container
 */
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => {
      // Filter out hidden elements
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
}

/**
 * Hook to trap focus within a container
 *
 * Traps keyboard focus within a container element, cycling through
 * focusable elements when Tab is pressed. Essential for modal accessibility.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  options: UseFocusTrapOptions = {},
): void {
  const {
    enabled = true,
    onEscape,
    autoFocus = true,
    restoreFocus = true,
    initialFocusRef,
    finalFocusRef,
  } = options;

  // Store the previously focused element to restore on unmount
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Handle Tab key navigation
  const handleKeyDown = (event: KeyboardEvent) => {
    if (!containerRef.current) return;

    // Handle Escape
    if (event.key === 'Escape' && onEscape) {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
      return;
    }

    // Handle Tab
    if (event.key === 'Tab') {
      const focusableElements = getFocusableElements(containerRef.current);
      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (!firstElement || !lastElement) return;

      if (event.shiftKey) {
        // Shift+Tab: going backwards
        if (document.activeElement === firstElement) {
          event.preventDefault();
          lastElement.focus();
        }
      } else {
        // Tab: going forwards
        if (document.activeElement === lastElement) {
          event.preventDefault();
          firstElement.focus();
        }
      }
    }
  };

  // Auto-focus and restore-focus: only runs when the trap is enabled/disabled,
  // NOT when handleKeyDown changes (prevents re-focusing the first element on
  // every re-render caused by query state updates).
  useEffect(() => {
    if (!enabled || !containerRef.current) return;

    // Store the currently focused element
    previousFocusRef.current = document.activeElement as HTMLElement;

    // Focus the initial element
    if (autoFocus) {
      const initialElement = initialFocusRef?.current;
      if (initialElement) {
        initialElement.focus();
      } else {
        const focusableElements = getFocusableElements(containerRef.current);
        const firstElement = focusableElements[0];
        if (firstElement) {
          firstElement.focus();
        }
      }
    }

    // Capture ref values for cleanup
    const finalElement = finalFocusRef?.current;
    const previousElement = previousFocusRef.current;

    // Cleanup: restore focus when trap is disabled/unmounted
    return () => {
      if (restoreFocus) {
        const elementToFocus = finalElement || previousElement;
        if (elementToFocus && typeof elementToFocus.focus === 'function') {
          // Small delay to ensure the modal is fully unmounted
          requestAnimationFrame(() => {
            elementToFocus.focus();
          });
        }
      }
    };
    // Dependencies intentionally limited: auto-focus must only fire on open/close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Keyboard listener: updated whenever handleKeyDown changes, but does NOT
  // trigger auto-focus so re-renders won't steal focus from the input.
  useEffect(() => {
    if (!enabled) return;

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, onEscape]);
}
