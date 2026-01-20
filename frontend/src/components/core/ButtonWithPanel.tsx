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
import { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
import { Card } from './Card';
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
}: ButtonWithPanelProps) {
  // Determine if component is controlled
  const isControlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = isControlled ? controlledOpen : internalOpen;
  
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  
  // Handle open state changes
  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (!isControlled) {
      setInternalOpen(newOpen);
    }
    onOpenChange?.(newOpen);
  }, [isControlled, onOpenChange]);
  
  // Toggle panel
  const togglePanel = useCallback(() => {
    handleOpenChange(!isOpen);
  }, [isOpen, handleOpenChange]);
  
  // Close panel
  const closePanel = useCallback(() => {
    handleOpenChange(false);
  }, [handleOpenChange]);
  
  // Click outside handler
  useEffect(() => {
    if (!isOpen || !closeOnClickOutside) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        closePanel();
      }
    };
    
    // Use mousedown to catch clicks before blur events
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, closeOnClickOutside, closePanel]);
  
  // Escape key handler
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closePanel();
        buttonRef.current?.focus();
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeOnEscape, closePanel]);
  
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
          icon={icon}
          variant={variant}
          size={size}
          active={isOpen}
          onClick={togglePanel}
          className={buttonClassName}
          title={tooltip}
          disabled={disabled}
          {...buttonProps}
        >
          {buttonText}
        </Button>
      )}
      
      {isOpen && (
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
          <div className="btn-panel__content">
            {typeof children === 'function' ? children(closePanel) : children}
          </div>
        </Card>
      )}
    </div>
  );
}

export default ButtonWithPanel;
