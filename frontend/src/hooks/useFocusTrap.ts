/**
 * useFocusTrap - Hook for trapping focus within a container
 * 
 * Traps keyboard focus within a container element, cycling through
 * focusable elements when Tab is pressed. Essential for modal accessibility.
 * 
 * Features:
 * - Auto-focus first focusable element on mount
 * - Restore focus on unmount
 * - Trap Tab/Shift+Tab navigation
 * - Optional escape key handling
 * - Support for custom initial focus element
 * 
 * Usage:
 * ```tsx
 * function Modal({ onClose }) {
 *   const containerRef = useRef<HTMLDivElement>(null);
 *   
 *   useFocusTrap(containerRef, {
 *     enabled: true,
 *     onEscape: onClose,
 *   });
 *   
 *   return (
 *     <div ref={containerRef}>
 *       <button>First</button>
 *       <button>Last</button>
 *     </div>
 *   );
 * }
 * ```
 */
import { useEffect, useRef, useCallback, type RefObject } from 'react';

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
  onEscape?: () => void;
  /** Whether to auto-focus the first element on mount (default: true) */
  autoFocus?: boolean;
  /** Whether to restore focus on unmount (default: true) */
  restoreFocus?: boolean;
  /** Ref to element that should receive initial focus */
  initialFocusRef?: RefObject<HTMLElement>;
  /** Ref to element that should receive focus on close */
  finalFocusRef?: RefObject<HTMLElement>;
}

/**
 * Get all focusable elements within a container
 */
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(el => {
      // Filter out hidden elements
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
}

/**
 * Hook to trap focus within a container
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  options: UseFocusTrapOptions = {}
) {
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
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
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
  }, [containerRef, onEscape]);
  
  // Set up focus trap
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
        if (focusableElements.length > 0) {
          focusableElements[0].focus();
        }
      }
    }
    
    // Add keyboard listener
    document.addEventListener('keydown', handleKeyDown);
    
    // Capture ref values for cleanup
    const finalElement = finalFocusRef?.current;
    const previousElement = previousFocusRef.current;
    
    // Cleanup
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      
      // Restore focus
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
  }, [enabled, containerRef, autoFocus, restoreFocus, initialFocusRef, finalFocusRef, handleKeyDown]);
}

/**
 * Hook to manage focus within a list (arrow key navigation)
 */
export function useFocusableList(
  containerRef: RefObject<HTMLElement | null>,
  options: {
    enabled?: boolean;
    selector?: string;
    wrap?: boolean; // Wrap around at ends
    vertical?: boolean; // Up/Down vs Left/Right
    onSelect?: (element: HTMLElement, index: number) => void;
  } = {}
) {
  const {
    enabled = true,
    selector = '[role="option"], [role="menuitem"], button, a',
    wrap = true,
    vertical = true,
    onSelect,
  } = options;
  
  const currentIndexRef = useRef(0);
  
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!containerRef.current) return;
    
    const elements = Array.from(
      containerRef.current.querySelectorAll<HTMLElement>(selector)
    ).filter(el => !el.hasAttribute('disabled'));
    
    if (elements.length === 0) return;
    
    const upKey = vertical ? 'ArrowUp' : 'ArrowLeft';
    const downKey = vertical ? 'ArrowDown' : 'ArrowRight';
    
    let newIndex = currentIndexRef.current;
    
    if (event.key === upKey) {
      event.preventDefault();
      newIndex = currentIndexRef.current - 1;
      if (newIndex < 0) {
        newIndex = wrap ? elements.length - 1 : 0;
      }
    } else if (event.key === downKey) {
      event.preventDefault();
      newIndex = currentIndexRef.current + 1;
      if (newIndex >= elements.length) {
        newIndex = wrap ? 0 : elements.length - 1;
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.(elements[currentIndexRef.current], currentIndexRef.current);
      return;
    } else if (event.key === 'Home') {
      event.preventDefault();
      newIndex = 0;
    } else if (event.key === 'End') {
      event.preventDefault();
      newIndex = elements.length - 1;
    } else {
      return;
    }
    
    currentIndexRef.current = newIndex;
    elements[newIndex]?.focus();
  }, [containerRef, selector, wrap, vertical, onSelect]);
  
  useEffect(() => {
    if (!enabled || !containerRef.current) return;
    
    const container = containerRef.current;
    container.addEventListener('keydown', handleKeyDown);
    
    return () => {
      container.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, containerRef, handleKeyDown]);
  
  // Return helper to programmatically set focus
  const setFocusIndex = useCallback((index: number) => {
    if (!containerRef.current) return;
    
    const elements = Array.from(
      containerRef.current.querySelectorAll<HTMLElement>(selector)
    );
    
    if (index >= 0 && index < elements.length) {
      currentIndexRef.current = index;
      elements[index]?.focus();
    }
  }, [containerRef, selector]);
  
  return { setFocusIndex };
}

export default useFocusTrap;
