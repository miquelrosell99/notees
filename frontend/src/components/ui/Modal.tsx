/**
 * Modal Component
 * 
 * A reusable modal component that provides consistent styling for
 * modal dialogs throughout the app.
 * 
 * Features:
 * - Backdrop click to close
 * - Escape key to close
 * - Focus trapping (optional)
 * - Consistent header/footer structure
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Card } from './Card';
import { Button } from './Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useOverlaySurface } from '@/hooks/useOverlaySurface';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  SHEET_DRAG_SLOP_PX,
  shouldEngageSheetDrag,
  shouldDismissSheet,
  type SheetDragRegion,
} from './sheetGesture';
import './Modal.css';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';
export type ModalVariant = 'dialog' | 'sheet' | 'auto';

export interface ModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Modal title (shown in header) */
  title?: string;
  /** Optional element to render left of the title (e.g., button) */
  headerLeftElement?: ReactNode;
  /** Modal size */
  size?: ModalSize;
  /** Modal presentation variant. `auto` renders as a bottom-sheet on mobile. */
  variant?: ModalVariant;
  /** Modal content */
  children: ReactNode;
  /** Footer content (typically buttons) */
  footer?: ReactNode;
  /** Whether to show close button in header */
  showCloseButton?: boolean;
  /** Whether clicking backdrop closes modal */
  closeOnBackdrop?: boolean;
  /** Whether pressing Escape closes modal */
  closeOnEscape?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Content class name */
  contentClassName?: string;
}

/**
 * Modal component for dialogs, forms, and confirmations.
 * Provides consistent backdrop, escape handling, and layout.
 */
export function Modal({
  isOpen,
  onClose,
  title,
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
  // Bottom-sheet below the tablet breakpoint, matching the app layout switch.
  const isMobile = useIsMobile();
  const isSheet = variant === 'sheet' || (variant === 'auto' && isMobile);

  // Register with the global overlay stack so Escape closes this modal
  // regardless of where DOM focus is, and in the correct LIFO order.
  useOverlaySurface({
    type: 'modal',
    enabled: isOpen && closeOnEscape,
    onClose,
  });

  // Enable focus trap for accessibility (Tab cycling / restore focus).
  // Escape handling is owned by the global overlay stack.
  useFocusTrap(containerRef, {
    enabled: isOpen,
    onEscape: undefined,
  });

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (closeOnBackdrop && e.target === e.currentTarget) {
        onClose();
      }
    },
    [closeOnBackdrop, onClose]
  );

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

  if (!isOpen) return null;

  const modal = (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop closes on click; explicit close button provided
    <div
      ref={backdropRef}
      className="modal-backdrop"
      onClick={handleBackdropClick}
    >
      <Card
        ref={containerRef}
        className={`modal modal--${size} ${isSheet ? 'modal--sheet' : ''} ${className}`}
        elevation="high"
        padding={false}
        radius={isSheet ? 'none' : 'xl'}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'modal-title' : undefined}
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
            {title && <h2 id="modal-title" className="modal__title">{title}</h2>}
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
      </Card>
    </div>
  );

  // Portal to document.body so modals always float above everything,
  // even when rendered inside editor portals or other
  // constrained DOM contexts (contentEditable, overflow containers, etc.)
  return createPortal(modal, document.body);
}

