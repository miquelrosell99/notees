/**
 * usePopupDismissal — the shared dismissal layer for popup surfaces.
 *
 * One implementation of the platform convention: every popup closes
 * on Escape and on a pointer-down outside itself. The hook installs both
 * document listeners while the popup is open and removes them on close /
 * unmount, so callers never manage subscription lifecycle themselves.
 *
 * Escape contract: only an Escape that did NOT originate inside the popup
 * dismisses. Keydowns that originate inside the popup belong to the popup's
 * own children — a search field may consume Escape for a sub-state (and must
 * stopPropagation to protect it), while popups whose children don't handle
 * Escape wire `onKeyDown` at the popup root to close. Either way the popup
 * stays in charge of its own interior.
 *
 * Pointer contract: a pointer-down on the popup element or any declared
 * anchor (usually the trigger button) never dismisses; anywhere else closes.
 * Interactive children therefore never self-dismiss by accident, and existing
 * stopPropagation discipline on popup roots keeps their presses from leaking
 * into other surfaces' outside-click handlers.
 */

import { useEffect, useRef, type RefObject } from "react";

/**
 * Marker attribute the seam stamps on the popup root while open. The overlay
 * system keys off it:
 * - `[data-fleet-popup] { pointer-events: auto }` re-enables hit-testing when
 *   a surface above the page (a modal dialog) locks the body's pointer events;
 * - the fleet Modal treats a press inside a marked popup as an INSIDE press,
 *   not an outside one, so opening a picker from a dialog never dismisses it;
 * - the seam lifts `aria-hidden` off the popup root for the same reason (the
 *   modal's background-hiding pass hides portaled popups).
 */
export const FLEET_POPUP_ATTR = "data-fleet-popup";

/**
 * Count of stamped popups currently open. While non-zero, the app overlay
 * stack (useOverlaySurface — the Escape authority for modal surfaces) stays
 * silent: fleet popups own Escape, and the stack resumes LIFO once the last
 * one closes.
 */
let openFleetPopupCount = 0;

export function hasOpenFleetPopups(): boolean {
  return openFleetPopupCount > 0;
}

export interface UsePopupDismissalOptions {
  /** The popup element. Pointer-downs inside it never dismiss. */
  popupRef: RefObject<HTMLElement | null>;
  /**
   * Extra elements treated as part of the surface for the OUTSIDE-POINTER
   * check only (typically the trigger button — clicking it toggles instead
   * of dismissing). Escape originating on an anchor still closes.
   */
  anchorRefs?: RefObject<HTMLElement | null>[] | undefined;
  /** Whether the popup is currently open. */
  isOpen: boolean;
  /** Close callback. */
  onClose: () => void;
  /** Escape closes (default true). */
  closeOnEscape?: boolean | undefined;
  /** Pointer-down outside closes (default true). */
  closeOnOutsidePress?: boolean | undefined;
}

export function usePopupDismissal(options: UsePopupDismissalOptions): void {
  const {
    popupRef,
    anchorRefs,
    isOpen,
    onClose,
    closeOnEscape = true,
    closeOnOutsidePress = true,
  } = options;

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const anchorsRef = useRef(anchorRefs);
  anchorsRef.current = anchorRefs;

  useEffect(() => {
    if (!isOpen) return;

    const isInsidePopup = (target: EventTarget | null): boolean =>
      target instanceof Node && popupRef.current !== null && popupRef.current.contains(target);

    const isOnAnchor = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      (anchorsRef.current?.some((ref) => ref.current?.contains(target) ?? false) ?? false);

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // Escape that originated inside the popup is owned by the popup's own
      // children (see the file doc); from anywhere else it dismisses.
      if (isInsidePopup(event.target)) return;
      onCloseRef.current();
    };

    const handlePointerDown = (event: PointerEvent): void => {
      if (isInsidePopup(event.target) || isOnAnchor(event.target)) return;
      onCloseRef.current();
    };

    if (closeOnEscape) document.addEventListener("keydown", handleKeyDown);
    if (closeOnOutsidePress) document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isOpen, closeOnEscape, closeOnOutsidePress, popupRef]);

  // Overlay-system contract: mark the popup root and keep it reachable while
  // open. The aria-hidden lift counters the modal's background-hiding pass,
  // which also hides portaled popups (and re-hides dynamically added ones —
  // hence the observer re-asserting the lift).
  useEffect(() => {
    if (!isOpen) return;
    const popup = popupRef.current;
    if (!popup) return;

    popup.setAttribute(FLEET_POPUP_ATTR, "");
    openFleetPopupCount += 1;
    const previousAriaHidden = popup.getAttribute("aria-hidden");
    const lift = () => {
      if (popup.hasAttribute("aria-hidden")) popup.removeAttribute("aria-hidden");
    };
    lift();
    const observer = new MutationObserver(lift);
    observer.observe(popup, { attributes: true, attributeFilter: ["aria-hidden"] });

    return () => {
      openFleetPopupCount -= 1;
      observer.disconnect();
      popup.removeAttribute(FLEET_POPUP_ATTR);
      if (previousAriaHidden !== null) popup.setAttribute("aria-hidden", previousAriaHidden);
    };
  }, [isOpen, popupRef]);
}
