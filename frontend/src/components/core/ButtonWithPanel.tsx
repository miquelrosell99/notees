/**
 * ButtonWithPanel Component
 * 
 * A button that shows a floating panel beside it when clicked.
 * Uses the Button component internally for consistent styling.
 * 
 * Usage:
 * <ButtonWithPanel icon={mdiCog} panelPosition="right">
 *   <div>Panel content here</div>
 * </ButtonWithPanel>
 */
import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
import { Card } from './Card';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import './ButtonWithPanel.css';

export type PanelPosition = 'left' | 'right' | 'top' | 'bottom';
export type PanelAlignment = 'start' | 'center' | 'end';

export interface ButtonWithPanelProps {
  /** MDI icon path for the button */
  icon?: string;
  /** Button text (optional) */
  buttonText?: string;
  /** Visual variant of the button */
  variant?: ButtonVariant;
  /** Size of the button */
  size?: ButtonSize;
  /** Where the panel appears relative to the button */
  panelPosition?: PanelPosition;
  /** Alignment of the panel along the edge */
  panelAlignment?: PanelAlignment;
  /** Custom panel width */
  panelWidth?: number | string;
  /** Custom panel max-height */
  panelMaxHeight?: number | string;
  /** Whether the panel is open (controlled mode) */
  open?: boolean;
  /** Callback when panel open state changes */
  onOpenChange?: (open: boolean) => void;
  /** Close panel when clicking outside */
  closeOnClickOutside?: boolean;
  /** Close panel when pressing Escape */
  closeOnEscape?: boolean;
  /** Panel title (shows header) */
  title?: string;
  /** Show close button in header */
  showCloseButton?: boolean;
  /** Button className */
  buttonClassName?: string;
  /** Panel className */
  panelClassName?: string;
  /** Container className */
  className?: string;
  /** Tooltip for the button */
  tooltip?: string;
  /** Whether the button is disabled */
  disabled?: boolean;
  /** Panel content - can be ReactNode or render function that receives closePanel */
  children?: ReactNode | ((closePanel: () => void) => ReactNode);
  /** Additional button props */
  buttonProps?: Partial<ButtonProps>;
  /** Custom trigger element - replaces the default Button when provided */
  customTrigger?: ReactNode;
  /** Render panel in a portal to escape overflow containers */
  usePortal?: boolean;
  /**
   * When true, the left-click activates `onActivate` (does NOT open the panel),
   * and a right-click (context-menu) opens the panel instead.
   */
  openPanelOnRightClick?: boolean;
  /**
   * Called on left-click when `openPanelOnRightClick` is true.
   * In this mode the panel is only opened via right-click.
   */
  onActivate?: () => void;
  /** Whether the button appears in an active/pressed state (e.g. the tool is selected) */
  active?: boolean;
}

export function ButtonWithPanel({
  icon,
  buttonText,
  variant = 'default',
  size = 'md',
  panelPosition = 'right',
  panelAlignment = 'start',
  panelWidth = 280,
  panelMaxHeight,
  open: controlledOpen,
  onOpenChange,
  closeOnClickOutside = true,
  closeOnEscape = true,
  title,
  showCloseButton = true,
  buttonClassName = '',
  panelClassName = '',
  className = '',
  tooltip,
  disabled,
  children,
  buttonProps = {},
  customTrigger,
  usePortal = false,
  openPanelOnRightClick = false,
  onActivate,
  active: activeProp = false,
}: ButtonWithPanelProps) {
  // Determine if component is controlled
  const isControlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = isControlled ? controlledOpen : internalOpen;
  
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [portalPosition, setPortalPosition] = useState<{ top?: number; bottom?: number; left: number }>({ left: 0 });
  const [selectedIndex, setSelectedIndex] = useState(0);
  
  // Handle open state changes
  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (!isControlled) {
      setInternalOpen(newOpen);
    }
    onOpenChange?.(newOpen);
  }, [isControlled, onOpenChange]);
  
  // Toggle panel
  const togglePanel = useCallback(() => {
    if (!isOpen) {
      setSelectedIndex(0);
    }
    handleOpenChange(!isOpen);
  }, [isOpen, handleOpenChange]);
  
  // Close panel
  const closePanel = useCallback(() => {
    handleOpenChange(false);
  }, [handleOpenChange]);
  
  // Close on escape key
  useEscapeKey(() => {
    if (closeOnEscape) {
      closePanel();
      buttonRef.current?.focus();
    }
  }, isOpen);

  // Close on click outside
  useClickOutside([containerRef, panelRef], closePanel, isOpen && closeOnClickOutside);
  
  // Keyboard navigation handler
  useEffect(() => {
    if (!isOpen) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      // Arrow key navigation
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = panelRef.current?.querySelectorAll('[data-menu-item]');
        if (!items || items.length === 0) return;
        
        setSelectedIndex(prev => {
          if (e.key === 'ArrowDown') {
            return Math.min(prev + 1, items.length - 1);
          } else {
            return Math.max(prev - 1, 0);
          }
        });
      }
      
      // Enter key to select
      if (e.key === 'Enter') {
        e.preventDefault();
        const items = panelRef.current?.querySelectorAll('[data-menu-item]');
        if (items && items[selectedIndex]) {
          (items[selectedIndex] as HTMLElement).click();
        }
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex]);

  // Calculate portal position when panel opens with viewport-aware positioning
  useEffect(() => {
    if (!usePortal || !isOpen || !containerRef.current) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const gap = 8;
    const actualWidth = typeof panelWidth === 'number' ? panelWidth : 280;
    const estimatedHeight = 300; // Estimate for collision detection
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    let top = 0;
    let left = 0;
    const preferredPosition = panelPosition;
    
    // Try to fit in preferred position, fallback if doesn't fit
    const tryPosition = (pos: PanelPosition): { top: number; left: number; fits: boolean } => {
      let t = 0;
      let l = 0;
      
      switch (pos) {
        case 'right':
          l = rect.right + gap;
          t = panelAlignment === 'start' ? rect.top 
              : panelAlignment === 'end' ? rect.bottom - estimatedHeight
              : rect.top + rect.height / 2 - estimatedHeight / 2;
          return { top: t, left: l, fits: l + actualWidth <= viewportWidth - 16 };
        case 'left':
          l = rect.left - gap - actualWidth;
          t = panelAlignment === 'start' ? rect.top 
              : panelAlignment === 'end' ? rect.bottom - estimatedHeight
              : rect.top + rect.height / 2 - estimatedHeight / 2;
          return { top: t, left: l, fits: l >= 16 };
        case 'bottom':
          t = rect.bottom + gap;
          l = panelAlignment === 'start' ? rect.left 
               : panelAlignment === 'end' ? rect.right - actualWidth 
               : rect.left + rect.width / 2 - actualWidth / 2;
          return { top: t, left: l, fits: t + estimatedHeight <= viewportHeight - 16 };
        case 'top':
          t = rect.top - gap - estimatedHeight;
          l = panelAlignment === 'start' ? rect.left 
               : panelAlignment === 'end' ? rect.right - actualWidth 
               : rect.left + rect.width / 2 - actualWidth / 2;
          return { top: t, left: l, fits: rect.top - gap >= estimatedHeight + 16 };
      }
    };
    
    // Try preferred position first
    let result = tryPosition(preferredPosition);
    let chosenPosition = preferredPosition;
    
    // If doesn't fit, try alternatives
    if (!result.fits) {
      const alternatives: PanelPosition[] = 
        preferredPosition === 'right' ? ['left', 'bottom', 'top'] :
        preferredPosition === 'left' ? ['right', 'bottom', 'top'] :
        preferredPosition === 'bottom' ? ['top', 'right', 'left'] :
        ['bottom', 'right', 'left'];
      
      for (const alt of alternatives) {
        result = tryPosition(alt);
        if (result.fits) { chosenPosition = alt; break; }
      }
    }
    
    // Clamp horizontal
    left = Math.max(16, Math.min(result.left, viewportWidth - actualWidth - 16));

    // eslint-disable-next-line react-hooks/set-state-in-effect -- Synchronous position calculation based on DOM measurements
    if (chosenPosition === 'top') {
      // Anchor bottom edge to button top: panel grows upward, height-independent
      const bottomAnchor = viewportHeight - (rect.top - gap);
      setPortalPosition({ bottom: Math.max(16, bottomAnchor), left });
    } else {
      top = Math.max(16, Math.min(result.top, viewportHeight - estimatedHeight - 16));
      setPortalPosition({ top, left });
    }
  }, [isOpen, usePortal, panelWidth, panelPosition, panelAlignment]);
  
  // Calculate panel position styles
  const getPanelStyle = (): React.CSSProperties => {
    const style: React.CSSProperties = {};
    
    // Width
    if (typeof panelWidth === 'number') {
      style.width = `${panelWidth}px`;
    } else {
      style.width = panelWidth;
    }
    
    // Max height
    if (panelMaxHeight) {
      if (typeof panelMaxHeight === 'number') {
        style.maxHeight = `${panelMaxHeight}px`;
      } else {
        style.maxHeight = panelMaxHeight;
      }
    }
    
    return style;
  };
  
  const containerClasses = [
    'btn-panel-container',
    `btn-panel-container--${panelPosition}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  
  const panelClasses = [
    'btn-panel',
    `btn-panel--${panelPosition}`,
    `btn-panel--align-${panelAlignment}`,
    title && 'btn-panel--has-header',
    panelClassName,
  ]
    .filter(Boolean)
    .join(' ');
  
  return (
    <div className={containerClasses} ref={containerRef}>
      {customTrigger ? (
        <div 
          className={`btn-panel-custom-trigger ${buttonClassName}`}
          onClick={disabled ? undefined : togglePanel}
          style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
          role="button"
          tabIndex={disabled ? -1 : 0}
          onKeyDown={(e) => {
            if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              togglePanel();
            }
          }}
        >
          {customTrigger}
        </div>
      ) : (
        <Button
          ref={buttonRef}
          variant={variant}
          size={size}
          active={openPanelOnRightClick ? (activeProp || isOpen) : isOpen}
          className={buttonClassName}
          title={openPanelOnRightClick ? (tooltip ? `${tooltip} (right-click for options)` : 'Right-click for options') : tooltip}
          disabled={disabled}
          {...buttonProps}
          icon={buttonProps.icon ?? icon}
          onClick={openPanelOnRightClick ? (disabled ? undefined : onActivate) : togglePanel}
          onContextMenu={openPanelOnRightClick ? (e) => { e.preventDefault(); if (!disabled) togglePanel(); } : undefined}
        >
          {buttonText}
        </Button>
      )}
      
      {isOpen && !usePortal && (
        <Card
          ref={panelRef}
          className={panelClasses}
          style={getPanelStyle()}
          role="dialog"
          aria-modal="true"
          padding={false}
          elevation="medium"
        >
          {title && (
            <div className="btn-panel__header">
              <h4 className="btn-panel__title">{title}</h4>
              {showCloseButton && (
                <button
                  className="btn-panel__close"
                  onClick={closePanel}
                  aria-label="Close panel"
                >
                  ×
                </button>
              )}
            </div>
          )}
          <div className="btn-panel__content" data-selected-index={selectedIndex}>
            {typeof children === 'function' ? children(closePanel) : children}
          </div>
        </Card>
      )}
      
      {isOpen && usePortal && createPortal(
        <Card
          ref={panelRef}
          className={`${panelClasses} btn-panel--portal`}
          style={{
            ...getPanelStyle(),
            position: 'fixed',
            ...(portalPosition.bottom !== undefined
              ? { bottom: `${portalPosition.bottom}px` }
              : { top: `${portalPosition.top ?? 0}px` }),
            left: `${portalPosition.left}px`,
            zIndex: '10001 !important' as any,
          }}
          role="dialog"
          aria-modal="true"
          padding={false}
          elevation="medium"
        >
          {title && (
            <div className="btn-panel__header">
              <h4 className="btn-panel__title">{title}</h4>
              {showCloseButton && (
                <button
                  className="btn-panel__close"
                  onClick={closePanel}
                  aria-label="Close panel"
                >
                  ×
                </button>
              )}
            </div>
          )}
          <div className="btn-panel__content" data-selected-index={selectedIndex}>
            {typeof children === 'function' ? children(closePanel) : children}
          </div>
        </Card>,
        document.body
      )}
    </div>
  );
}

export default ButtonWithPanel;
