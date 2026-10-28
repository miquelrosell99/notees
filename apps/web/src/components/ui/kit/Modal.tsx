/**
 * Modal Component
 *
 * A reusable modal component that provides consistent styling for
 * modal dialogs throughout the app.
 *
 * Thin fleet wrapper over the normalized catalog dialog's foundation
 * (Radix Dialog — the same primitives src/components/ui/dialog.tsx wraps),
 * with the fleet owning the layer semantics: the backdrop/scrim register,
 * the scroll lock, the background aria-hiding pass, and the Escape LIFO
 * ordering through the app overlay stack (useOverlaySurface — Radix's own
 * Escape is disabled so the stack stays the single Escape authority).
 *
 * The Root runs `modal={false}` on purpose. Radix's modal mode locks
 * `document.body` pointer-events and hard-traps focus, which makes any
 * hand-rolled popup portaled to `document.body` (every picker composing
 * usePopupDismissal) click-dead and un-focusable inside a dialog — the
 * "popups in modals" class of bugs. The fleet re-implements what modal mode
 * gave up, popup-aware:
 * - backdrop click to close (the app's contract; Radix outside-press
 *   dismissal is guarded so a press inside a `data-fleet-popup` surface —
 *   a portaled picker — never dismisses the dialog),
 * - body scroll lock (react-remove-scroll, the same library Radix wraps
 *   its overlay in, with the dialog content as a shard),
 * - background hidden from assistive tech (the same `hideOthers` pass
 *   Radix runs in modal mode; usePopupDismissal lifts the popup roots),
 * - soft focus containment (Radix's FocusScope still loops Tab while
 *   focus is inside the dialog, and lets it leave into a fleet popup).
 *
 * Features:
 * - Backdrop click to close
 * - Escape key to close (via the app overlay stack)
 * - Soft focus loop + close focus restore (Radix, non-modal layer)
 * - Consistent header/footer structure
 */
import { useCallback, useEffect, useRef, type ReactNode, type MouseEvent } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { RemoveScroll } from 'react-remove-scroll';
import { hideOthers } from 'aria-hidden';
import { Button } from './Button.js';
import { useOverlaySurface, useIsMobile } from './overlay-hooks.js';
import { FLEET_POPUP_ATTR } from './usePopupDismissal.js';
import {
  SHEET_DRAG_SLOP_PX,
  shouldEngageSheetDrag,
  shouldDismissSheet,
  type SheetDragRegion,
} from './sheetGesture.js';
import { cn } from './cn.js';
import './Modal.css';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';
export type ModalVariant = 'dialog' | 'sheet' | 'auto';

export interface ModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Modal title (shown in header) */
  title?: string | undefined;
  /** Accessible name when there is no visible `title` header. */
  ariaLabel?: string | undefined;
  /** Optional element to render left of the title (e.g., button) */
  headerLeftElement?: ReactNode | undefined;
  /** Modal size */
  size?: ModalSize | undefined;
  /** Modal presentation variant. `auto` renders as a bottom-sheet on mobile. */
  variant?: ModalVariant | undefined;
  /** Modal content */
  children: ReactNode;
  /** Footer content (typically buttons) */
  footer?: ReactNode | undefined;
  /** Whether to show close button in header */
  showCloseButton?: boolean | undefined;
  /** Whether clicking backdrop closes modal */
  closeOnBackdrop?: boolean | undefined;
  /** Whether pressing Escape closes modal */
  closeOnEscape?: boolean | undefined;
  /** Additional CSS class */
  className?: string | undefined;
  /** Content class name */
  contentClassName?: string | undefined;
}

/**
 * Modal component for dialogs, forms, and confirmations.
 * Provides consistent backdrop, escape handling, and layout.
 */
export function Modal({
  isOpen,
  onClose,
  title,
  ariaLabel,
  headerLeftElement,
  size = 'md',
  variant = 'auto',
  children,
  footer,
  showCloseButton = true,
  closeOnBackdrop = true,
  closeOnEscape = true,
  className = '',
  contentClassName = '',
}: ModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const backgroundUndoRef = useRef<(() => void) | null>(null);

  // Background hiding pass: same `hideOthers` Radix runs in modal mode, so
  // the rest of the app stays out of the accessibility tree while a dialog
  // is open. Portaled fleet popups are stamped by usePopupDismissal, which
  // lifts the hiding from its own root while they are open.
  //
  // The content node is captured through a callback ref, not a mount effect:
  // Radix's Presence can mount the portal content only after mount effects
  // have already run, so an effect keyed on isOpen would see a null ref for
  // an initially-open dialog. The callback ref is the one place the node is
  // guaranteed to be observed (mount AND unmount).
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    backgroundUndoRef.current?.();
    backgroundUndoRef.current = null;
    if (node) backgroundUndoRef.current = hideOthers(node);
  }, []);
  // Bottom-sheet below the tablet breakpoint, matching the app layout switch.
  const isMobile = useIsMobile();
  const isSheet = variant === 'sheet' || (variant === 'auto' && isMobile);

  // Register with the overlay stack so Escape closes this modal
  // regardless of where DOM focus is, and in the correct LIFO order.
  // Radix's own Escape handling is disabled below — the stack is the
  // single Escape authority across every overlay surface in the app.
  useOverlaySurface({
    type: 'modal',
    enabled: isOpen && closeOnEscape,
    onClose,
  });

  // A press that lands on another overlay surface is an INSIDE press as far
  // as this dialog is concerned:
  // - a portaled fleet popup (a picker opened from this dialog) — a body
  //   sibling outside this dialog's DOM subtree;
  // - a stacked fleet dialog (the confirmation-over-form pattern) — same.
  // Radix would otherwise treat the interaction as outside and dismiss this
  // dialog underneath the user's click (a focus move into the stacked
  // dialog does exactly that through the focus-outside path).
  // A scrim press is the exception that proves the rule: it closes only the
  // dialog whose scrim it is — another dialog's scrim leaves this one alone.
  const isOverlaySurfacePress = (event: { target: EventTarget | null }): boolean => {
    if (!(event.target instanceof Element)) return false;
    if (event.target.closest(`[${FLEET_POPUP_ATTR}]`) !== null) return true;
    if (event.target.closest('.modal') !== null) return true;
    const scrim = event.target.closest('.modal-backdrop');
    return scrim !== null && scrim !== backdropRef.current;
  };

  // Swipe-to-dismiss for the bottom-sheet variant. Mirrors the MobileLayout
  // drawer gesture: the drag offset is injected as a CSS variable, the
  // `modal--dragging` class disables the transform transition while dragging,
  // and the scrim fades proportionally to the offset.
  useEffect(() => {
    if (!isOpen || !isSheet) return;
    const sheet = containerRef.current;
    if (!sheet) return;
    const backdrop = backdropRef.current;

    let rafId: number | null = null;
    const drag = {
      touchId: null as number | null,
      region: null as SheetDragRegion | null,
      scrollerEl: null as HTMLElement | null,
      startY: 0,
      startTime: 0,
      offset: 0,
      sheetHeight: 0,
      engaged: false,
    };

    const setDragVars = (offset: number, scrimOpacity: number) => {
      sheet.style.setProperty('--sheet-drag-offset', `${offset}px`);
      backdrop?.style.setProperty('--sheet-scrim-opacity', String(scrimOpacity));
    };

    const resetDragVars = () => {
      sheet.style.removeProperty('--sheet-drag-offset');
      backdrop?.style.removeProperty('--sheet-scrim-opacity');
      sheet.classList.remove('modal--dragging');
    };

    const findTrackedTouch = (list: TouchList): Touch | null => {
      for (const touch of Array.from(list)) {
        if (touch.identifier === drag.touchId) return touch;
      }
      return null;
    };

    // The element a downward pull would scroll, if any: the first scrollable
    // ancestor between the touch target and the sheet. Sheet content may nest
    // its own scroll containers (e.g. the references card list), so this is
    // not necessarily `.modal__content`.
    const findScrollableAncestor = (el: HTMLElement): HTMLElement | null => {
      let node: HTMLElement | null = el;
      while (node && node !== sheet) {
        if (node.scrollHeight > node.clientHeight) {
          const overflowY = window.getComputedStyle(node).overflowY;
          if (overflowY === 'auto' || overflowY === 'scroll') return node;
        }
        node = node.parentElement;
      }
      return null;
    };

    const onTouchStart = (e: TouchEvent) => {
      if (drag.touchId !== null) return; // already tracking a touch
      const target = e.target as HTMLElement;
      const contentEl = sheet.querySelector<HTMLElement>('.modal__content');
      let region: SheetDragRegion | null = null;
      let scrollerEl: HTMLElement | null = null;
      if (target.closest('.modal__drag-handle') || target.closest('.modal__header')) {
        region = 'chrome';
      } else if (contentEl?.contains(target)) {
        region = 'content';
        scrollerEl = findScrollableAncestor(target);
      }
      if (!region) return;

      const touch = e.changedTouches[0];
      if (!touch) return;
      drag.touchId = touch.identifier;
      drag.region = region;
      drag.scrollerEl = scrollerEl;
      drag.startY = touch.clientY;
      drag.startTime = Date.now();
      drag.offset = 0;
      drag.sheetHeight = sheet.getBoundingClientRect().height;
      drag.engaged = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      const touch = findTrackedTouch(e.changedTouches);
      if (!touch || !drag.region) return;
      const dy = touch.clientY - drag.startY;

      if (!drag.engaged) {
        // An upward move is scrolling, not a dismiss — never engage this gesture.
        if (dy < -SHEET_DRAG_SLOP_PX) {
          drag.touchId = null;
          return;
        }
        if (!shouldEngageSheetDrag(drag.region, drag.scrollerEl?.scrollTop ?? 0, dy)) return;
        drag.engaged = true;
        sheet.classList.add('modal--dragging');
      }

      // The gesture owns the touch from here on: keep the content from scrolling.
      e.preventDefault();
      const offset = Math.max(0, dy);
      drag.offset = offset;
      const scrimOpacity = Math.max(0, 1 - offset / (drag.sheetHeight || 1));
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => setDragVars(offset, scrimOpacity));
    };

    const onTouchEnd = (e: TouchEvent) => {
      const touch = findTrackedTouch(e.changedTouches);
      if (!touch) return;
      drag.touchId = null;
      if (!drag.engaged) return;
      drag.engaged = false;

      const dt = Date.now() - drag.startTime;
      const velocity = dt > 0 ? drag.offset / dt : 0;
      const dismiss = shouldDismissSheet(drag.offset, velocity, drag.sheetHeight);

      // Re-enable the transition and clear the offset: the sheet snaps back.
      resetDragVars();
      if (dismiss) onClose();
    };

    const onTouchCancel = () => {
      if (drag.touchId === null) return;
      drag.touchId = null;
      drag.engaged = false;
      resetDragVars();
    };

    sheet.addEventListener('touchstart', onTouchStart, { passive: true });
    sheet.addEventListener('touchmove', onTouchMove, { passive: false });
    sheet.addEventListener('touchend', onTouchEnd, { passive: true });
    sheet.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      sheet.removeEventListener('touchstart', onTouchStart);
      sheet.removeEventListener('touchmove', onTouchMove);
      sheet.removeEventListener('touchend', onTouchEnd);
      sheet.removeEventListener('touchcancel', onTouchCancel);
      if (rafId !== null) cancelAnimationFrame(rafId);
      resetDragVars();
    };
  }, [isOpen, isSheet, onClose]);

  return (
    <DialogPrimitive.Root
      open={isOpen}
      // modal={false}: the fleet owns the layer semantics (see the file
      // docstring) so portaled fleet popups stay clickable and focusable
      // inside the dialog.
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <RemoveScroll allowPinchZoom shards={[containerRef]}>
          {/*
            The fleet's own scrim. Radix's DialogOverlay renders nothing when
            modal={false}, and the scroll lock lives here in modal mode — the
            fleet keeps both, with the dialog content as a scroll shard.
          */}
          <div
            ref={backdropRef}
            className="modal-backdrop"
            data-state={isOpen ? 'open' : 'closed'}
            // Radix dismisses on pointer-down outside; the app's contract is
            // backdrop CLICK (callers and tests drive click) — keep both.
            onClick={(event) => {
              if (closeOnBackdrop && event.target === event.currentTarget) onClose();
            }}
          />
          <DialogPrimitive.Content
            ref={setContainerRef}
            aria-label={title ? undefined : ariaLabel}
            aria-labelledby={title ? 'modal-title' : undefined}
            onEscapeKeyDown={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => {
              if (!closeOnBackdrop || isOverlaySurfacePress(event)) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (!closeOnBackdrop || isOverlaySurfacePress(event)) event.preventDefault();
            }}
            onFocusOutside={(event) => {
              // Focus may leave into a stacked dialog or a portaled popup;
              // the move must never dismiss this one (Radix non-modal
              // layers dismiss on focus-outside — the stacked-dialog
              // collapse). preventDefault only blocks the dismissal; the
              // focus move itself proceeds.
              event.preventDefault();
            }}
          className={cn(
            'modal',
            `modal--${size}`,
            isSheet && 'modal--sheet',
            // The Card surface the modal used to compose (elevation high,
            // radius sheet) — now token utilities on the dialog content.
            // Dialog register: 16px, not the sheet's 28.
            'bg-surface border border-outline-variant rounded-dialog shadow-level3 overflow-visible',
            className,
          )}
        >
          {isSheet && (
            <div className="modal__drag-handle" aria-hidden="true" />
          )}
          {(title || headerLeftElement || showCloseButton) && (
            <div className="modal__header">
              {headerLeftElement && (
                <div className="modal__header-left">
                  {headerLeftElement}
                </div>
              )}
              {title && (
                <h2 id="modal-title" className="modal__title">{title}</h2>
              )}
              {showCloseButton && (
                <Button
                  icon={"mdi mdi-close"}
                  aria-label="Close modal"
                  className="modal__close"
                  onClick={onClose}
                  size="sm"
                  variant="ghost"
                />
              )}
            </div>
          )}

          <div className={`modal__content ${contentClassName}`}>
            {children}
          </div>

          {footer && (
            <div className="modal__footer">
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
        </RemoveScroll>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
