/**
 * Overlay infrastructure — the shared behaviors every modal/popup leans on:
 *
 *  - `overlayStack`: a module-level LIFO registry of open overlay surfaces so
 *    Escape closes the topmost one regardless of where DOM focus is;
 *  - `useOverlaySurface`: register/unregister a surface with the stack;
 *  - `useFocusTrap`: keep Tab cycling inside an open overlay and restore
 *    focus to the trigger on close;
 *  - `useClickOutside`: close on pointer-down outside a set of elements;
 *  - `useIsMobile` / `useReducedMotion`: media-query subscriptions.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

// --- overlay stack ------------------------------------------------------------

export interface OverlaySurface {
  type: "modal" | "popup" | "menu";
  onClose: () => void;
}

const stack: OverlaySurface[] = [];

function handleKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  const top = stack[stack.length - 1];
  if (top === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  top.onClose();
}

function ensureGlobalListener() {
  document.addEventListener("keydown", handleKeyDown, true);
}

/**
 * Register a surface with the global overlay stack. Escape closes the most
 * recently registered surface first (LIFO). The surface unregisters on
 * disable/unmount.
 */
export function useOverlaySurface(surface: OverlaySurface & { enabled: boolean }): void {
  const { type, enabled, onClose } = surface;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    const entry: OverlaySurface = { type, onClose: () => onCloseRef.current() };
    stack.push(entry);
    ensureGlobalListener();
    return () => {
      const index = stack.lastIndexOf(entry);
      if (index !== -1) stack.splice(index, 1);
    };
  }, [type, enabled]);
}

// --- focus trap -----------------------------------------------------------------

export interface FocusTrapOptions {
  enabled: boolean;
  onEscape?: (() => void) | undefined;
  restoreFocus?: boolean;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Trap Tab/Shift+Tab cycling inside the container while enabled and return
 * focus to the previously focused element on close.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  options: FocusTrapOptions,
): void {
  const { enabled, restoreFocus = false } = options;
  const restoreTargetRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (restoreFocus) {
      restoreTargetRef.current = document.activeElement;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || containerRef.current === null) return;
      const focusable = Array.from(
        containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) {
        event.preventDefault();
        containerRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !containerRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      if (restoreFocus && restoreTargetRef.current instanceof HTMLElement) {
        restoreTargetRef.current.focus();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref identity is stable across renders
  }, [enabled, restoreFocus]);
}

// --- click outside ---------------------------------------------------------------

/** Close when a pointer-down lands outside every listed element. */
export function useClickOutside(
  refs: RefObject<HTMLElement | null>[],
  onClose: () => void,
  enabled: boolean,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const refsRef = useRef(refs);
  refsRef.current = refs;

  useEffect(() => {
    if (!enabled) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      const inside = refsRef.current.some((ref) => ref.current?.contains(target) ?? false);
      if (!inside) onCloseRef.current();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [enabled]);
}

// --- media queries ------------------------------------------------------------------

function useMediaQuery(query: string): boolean {
  const supported = typeof window !== "undefined" && typeof window.matchMedia === "function";
  const [matches, setMatches] = useState(() => (supported ? window.matchMedia(query).matches : false));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/** True below the tablet breakpoint (matches the app layout switch). */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 768px)");
}

/** True when the user prefers reduced motion. */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

// --- copied state ----------------------------------------------------------------

/** Transient "copied" flag with an automatic reset (drives the Copy button). */
export function useCopiedState(resetMs = 2000): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerCopy = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setCopied(true);
    timeoutRef.current = setTimeout(() => {
      setCopied(false);
      timeoutRef.current = null;
    }, resetMs);
  }, [resetMs]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return [copied, triggerCopy];
}
