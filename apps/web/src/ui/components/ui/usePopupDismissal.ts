/**
 * usePopupDismissal — the shared dismissal layer for popup surfaces.
 *
 * One implementation of the platform convention (§34.67): every popup closes
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
}
