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
import { useFocusTrap } from '@/hooks/useFocusTrap';
import './ButtonWithPanel.css';

/** Space between the trigger and the floating panel. */
const PANEL_GAP = 8;
/** Minimum clearance from the panel to the viewport edge. */
const VIEWPORT_MARGIN = 16;
/** Default panel width when no explicit width is provided. */
const DEFAULT_PANEL_WIDTH = 280;
/** Estimated panel height used for viewport collision detection. */
const ESTIMATED_PANEL_HEIGHT = 300;

export type PanelPosition = 'left' | 'right' | 'top' | 'bottom';
export type PanelAlignment = 'start' | 'center' | 'end';

export interface ButtonWithPanelProps {
  icon?: string;
  buttonText?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  panelPosition?: PanelPosition;
  panelAlignment?: PanelAlignment;
  panelWidth?: number | string;
  panelMaxHeight?: number | string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  closeOnClickOutside?: boolean;
  closeOnEscape?: boolean;
  title?: string;
  showCloseButton?: boolean;
  buttonClassName?: string;
  panelClassName?: string;
  className?: string;
  tooltip?: string;
  /** Accessible name for the popup dialog. Used when `title` is absent. */
  'aria-label'?: string;
  disabled?: boolean;
  children?: ReactNode | ((closePanel: () => void) => ReactNode);
  buttonProps?: Partial<ButtonProps>;
  customTrigger?: ReactNode;
  usePortal?: boolean;
  onActivate?: () => void;
  active?: boolean;
}

export function ButtonWithPanel({
  icon,
  buttonText,
  variant = 'default',
  size = 'md',
  panelPosition = 'right',
  panelAlignment = 'start',
  panelWidth = DEFAULT_PANEL_WIDTH,
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
  'aria-label': ariaLabel,
  disabled,
  children,
  buttonProps = {},
  customTrigger,
  usePortal = false,
  // openPanelOnRightClick = false, // removed
  onActivate,
  active: _activeProp = false,
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

  // Trap focus while the panel is open and return focus to the trigger on close
  useFocusTrap(panelRef, {
    enabled: isOpen,
    onEscape: closeOnEscape ? closePanel : undefined,
    restoreFocus: true,
  });

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
    const actualWidth = typeof panelWidth === 'number' ? panelWidth : DEFAULT_PANEL_WIDTH;
    const estimatedHeight = ESTIMATED_PANEL_HEIGHT;
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
          l = rect.right + PANEL_GAP;
          t = panelAlignment === 'start' ? rect.top 
              : panelAlignment === 'end' ? rect.bottom - estimatedHeight
              : rect.top + rect.height / 2 - estimatedHeight / 2;
          return { top: t, left: l, fits: l + actualWidth <= viewportWidth - VIEWPORT_MARGIN };
        case 'left':
          l = rect.left - PANEL_GAP - actualWidth;
          t = panelAlignment === 'start' ? rect.top 
              : panelAlignment === 'end' ? rect.bottom - estimatedHeight
              : rect.top + rect.height / 2 - estimatedHeight / 2;
          return { top: t, left: l, fits: l >= VIEWPORT_MARGIN };
        case 'bottom':
          t = rect.bottom + PANEL_GAP;
          l = panelAlignment === 'start' ? rect.left 
               : panelAlignment === 'end' ? rect.right - actualWidth 
               : rect.left + rect.width / 2 - actualWidth / 2;
          return { top: t, left: l, fits: t + estimatedHeight <= viewportHeight - VIEWPORT_MARGIN };
        case 'top':
          t = rect.top - PANEL_GAP - estimatedHeight;
          l = panelAlignment === 'start' ? rect.left 
               : panelAlignment === 'end' ? rect.right - actualWidth 
               : rect.left + rect.width / 2 - actualWidth / 2;
          return { top: t, left: l, fits: rect.top - PANEL_GAP >= estimatedHeight + VIEWPORT_MARGIN };
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
    left = Math.max(VIEWPORT_MARGIN, Math.min(result.left, viewportWidth - actualWidth - VIEWPORT_MARGIN));

    if (chosenPosition === 'top') {
      // Anchor bottom edge to button top: panel grows upward, height-independent
      const bottomAnchor = viewportHeight - (rect.top - PANEL_GAP);
      setPortalPosition({ bottom: Math.max(VIEWPORT_MARGIN, bottomAnchor), left });
    } else {
      top = Math.max(VIEWPORT_MARGIN, Math.min(result.top, viewportHeight - estimatedHeight - VIEWPORT_MARGIN));
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
        <Button
          variant="ghost"
          className={`btn-panel-custom-trigger ${buttonClassName}`}
          onClick={disabled ? undefined : togglePanel}
          disabled={disabled}
        >
          {customTrigger}
        </Button>
      ) : (
        <Button
          ref={buttonRef}
          variant={variant}
          size={size}
          active={isOpen}
          className={buttonClassName}
          title={tooltip}
          aria-label={buttonProps['aria-label'] ?? (!buttonText ? tooltip : undefined)}
          disabled={disabled}
          {...buttonProps}
          icon={buttonProps.icon ?? icon}
          onClick={disabled ? undefined : (onActivate ? onActivate : togglePanel)}
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
          aria-labelledby={title ? 'btn-panel-title' : undefined}
          aria-label={!title ? ariaLabel : undefined}
          padding={false}
          elevation="medium"
        >
          {title && (
            <div className="btn-panel__header">
              <h4 id="btn-panel-title" className="btn-panel__title">{title}</h4>
              {showCloseButton && (
                <Button
                  variant="ghost"
                  size="xs"
                  icon="mdi mdi-close"
                  className="btn-panel__close"
                  onClick={closePanel}
                  aria-label="Close panel"
                />
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
            zIndex: 'var(--z-modal)',
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? 'btn-panel-title' : undefined}
          aria-label={!title ? ariaLabel : undefined}
          padding={false}
          elevation="medium"
        >
          {title && (
            <div className="btn-panel__header">
              <h4 id="btn-panel-title" className="btn-panel__title">{title}</h4>
              {showCloseButton && (
                <Button
                  variant="ghost"
                  size="xs"
                  icon="mdi mdi-close"
                  className="btn-panel__close"
                  onClick={closePanel}
                  aria-label="Close panel"
                />
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

