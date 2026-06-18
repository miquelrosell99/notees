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
import { useEffect, useCallback, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Card } from './Card';
import { Button } from './Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';
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
function useIsMobileViewport(enabled: boolean) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const getMobileBreakpoint = () => {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue('--breakpoint-mobile')
        .trim();
      const value = parseInt(raw, 10);
      return Number.isFinite(value) ? value : 480;
    };

    let mq = window.matchMedia(`(max-width: ${getMobileBreakpoint()}px)`);
    const update = () => setIsMobile(mq.matches);

    update();

    const handleChange = () => {
      // Re-read the breakpoint in case the token changed at runtime.
      mq = window.matchMedia(`(max-width: ${getMobileBreakpoint()}px)`);
      update();
    };

    window.addEventListener('resize', handleChange);
    mq.addEventListener?.('change', update);
    return () => {
      window.removeEventListener('resize', handleChange);
      mq.removeEventListener?.('change', update);
    };
  }, [enabled]);

  return isMobile;
}

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
  const isMobile = useIsMobileViewport(variant === 'auto');
  const isSheet = variant === 'sheet' || (variant === 'auto' && isMobile);

  // Enable focus trap for accessibility
  useFocusTrap(containerRef, {
    enabled: isOpen,
    onEscape: closeOnEscape ? onClose : undefined,
  });
  
  // Handle escape key (fallback if focus trap doesn't catch it)
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, closeOnEscape, onClose]);

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (closeOnBackdrop && e.target === e.currentTarget) {
        onClose();
      }
    },
    [closeOnBackdrop, onClose]
  );

  if (!isOpen) return null;

  const modal = (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop closes on click; explicit close button provided
    <div
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
  // even when rendered inside Lexical editor portals or other
  // constrained DOM contexts (contentEditable, overflow containers, etc.)
  return createPortal(modal, document.body);
}

