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
 *
 * Positioning: the non-portal panel anchors with the CSS position classes
 * (.btn-panel--top / --bottom / --left / --right + alignment). The portal
 * panel computes a fixed position from the trigger's viewport rect, clamped
 * to a small viewport margin, and re-anchors on scroll/resize.
 */

import { useState, useRef, useEffect, useLayoutEffect, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from "./Button";
import { Card } from "./Card";
import { useClickOutside, useFocusTrap, useOverlaySurface } from "./overlayHooks";
import "./ButtonWithPanel.css";

/** Space between the trigger and the floating panel. */
const PANEL_GAP = 8;
/** Minimum clearance from the panel to the viewport edge. */
const VIEWPORT_MARGIN = 16;
/** Default panel width when no explicit width is provided. */
const DEFAULT_PANEL_WIDTH = 280;

export type PanelPosition = "left" | "right" | "top" | "bottom";
export type PanelAlignment = "start" | "center" | "end";

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
  "aria-label"?: string;
  disabled?: boolean;
  children?: ReactNode | ((closePanel: () => void) => ReactNode);
  buttonProps?: Partial<ButtonProps>;
  customTrigger?: ReactNode;
  usePortal?: boolean;
  onActivate?: () => void;
  active?: boolean;
}

/** Clamp a coordinate so the panel stays inside the viewport. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function ButtonWithPanel({
  icon,
  buttonText,
  variant = "default",
  size = "md",
  panelPosition = "right",
  panelAlignment = "start",
  panelWidth = DEFAULT_PANEL_WIDTH,
  panelMaxHeight,
  open: controlledOpen,
  onOpenChange,
  closeOnClickOutside = true,
  closeOnEscape = true,
  title,
  showCloseButton = true,
  buttonClassName = "",
  panelClassName = "",
  className = "",
  tooltip,
  "aria-label": ariaLabel,
  disabled,
  children,
  buttonProps = {},
  customTrigger,
  usePortal = false,
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
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Handle open state changes
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!isControlled) {
        setInternalOpen(newOpen);
      }
      onOpenChange?.(newOpen);
    },
    [isControlled, onOpenChange],
  );

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

  // Register with the global overlay stack so Escape closes the panel
  // regardless of where DOM focus is.
  useOverlaySurface({
    type: "popup",
    enabled: isOpen && closeOnEscape,
    onClose: closePanel,
  });

  // Trap focus while the panel is open and return focus to the trigger on close.
  useFocusTrap(panelRef, {
    enabled: isOpen,
    onEscape: undefined,
    restoreFocus: true,
  });

  // Close on click outside
  useClickOutside([containerRef, panelRef], closePanel, isOpen && closeOnClickOutside);

  // Keyboard navigation handler
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Arrow key navigation
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = panelRef.current?.querySelectorAll("[data-menu-item]");
        if (!items || items.length === 0) return;

        setSelectedIndex((prev) => {
          if (e.key === "ArrowDown") {
            return Math.min(prev + 1, items.length - 1);
          } else {
            return Math.max(prev - 1, 0);
          }
        });
      }

      // Enter key to select
      if (e.key === "Enter") {
        e.preventDefault();
        const items = panelRef.current?.querySelectorAll("[data-menu-item]");
        if (items && items[selectedIndex]) {
          (items[selectedIndex] as HTMLElement).click();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, selectedIndex]);

  // Position the portal panel from the trigger's viewport rect. Fixed
  // positioning keeps it above modal chrome (the export options panel uses
  // this); the panel re-anchors on scroll and resize.
  useLayoutEffect(() => {
    if (!isOpen || !usePortal) return;
    const reference = containerRef.current;
    const floating = panelRef.current;
    if (!reference || !floating) return;

    const update = () => {
      const trigger = reference.getBoundingClientRect();
      const panel = floating.getBoundingClientRect();
      const width = panel.width || floating.offsetWidth;
      const height = panel.height || floating.offsetHeight;

      let x: number;
      if (panelPosition === "right") {
        x = trigger.right + PANEL_GAP;
      } else if (panelPosition === "left") {
        x = trigger.left - width - PANEL_GAP;
      } else if (panelAlignment === "end") {
        x = trigger.right - width;
      } else if (panelAlignment === "center") {
        x = trigger.left + trigger.width / 2 - width / 2;
      } else {
        x = trigger.left;
      }

      let y: number;
      if (panelPosition === "bottom") {
        y = trigger.bottom + PANEL_GAP;
      } else if (panelPosition === "top") {
        y = trigger.top - height - PANEL_GAP;
      } else if (panelAlignment === "end") {
        y = trigger.bottom - height;
      } else if (panelAlignment === "center") {
        y = trigger.top + trigger.height / 2 - height / 2;
      } else {
        y = trigger.top;
      }

      const maxX = window.innerWidth - VIEWPORT_MARGIN - width;
      const maxY = window.innerHeight - VIEWPORT_MARGIN - height;
      floating.style.left = `${clamp(x, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, maxX))}px`;
      floating.style.top = `${clamp(y, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, maxY))}px`;
      // Neutralize the CSS position-class offsets (.btn-panel--bottom etc.)
      floating.style.right = "auto";
      floating.style.bottom = "auto";
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [isOpen, usePortal, panelPosition, panelAlignment]);

  // Calculate panel position styles
  const getPanelStyle = (): React.CSSProperties => {
    const style: React.CSSProperties = {};

    // Width
    if (typeof panelWidth === "number") {
      style.width = `${panelWidth}px`;
    } else {
      style.width = panelWidth;
    }

    // Max height
    if (panelMaxHeight) {
      if (typeof panelMaxHeight === "number") {
        style.maxHeight = `${panelMaxHeight}px`;
      } else {
        style.maxHeight = panelMaxHeight;
      }
    }

    return style;
  };

  const containerClasses = ["btn-panel-container", `btn-panel-container--${panelPosition}`, className]
    .filter(Boolean)
    .join(" ");

  const panelClasses = [
    "btn-panel",
    `btn-panel--${panelPosition}`,
    `btn-panel--align-${panelAlignment}`,
    title && "btn-panel--has-header",
    panelClassName,
  ]
    .filter(Boolean)
    .join(" ");

  const panelContent = typeof children === "function" ? children(closePanel) : children;
  const triggerIcon = buttonProps.icon ?? icon;
  const triggerAriaLabel = buttonProps["aria-label"] ?? (!buttonText ? tooltip : undefined);

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
          {...(tooltip !== undefined ? { title: tooltip } : {})}
          {...(triggerAriaLabel !== undefined ? { "aria-label": triggerAriaLabel } : {})}
          disabled={disabled}
          {...buttonProps}
          {...(triggerIcon !== undefined ? { icon: triggerIcon } : {})}
          onClick={disabled ? undefined : onActivate ? onActivate : togglePanel}
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
          aria-labelledby={title ? "btn-panel-title" : undefined}
          aria-label={!title ? ariaLabel : undefined}
          padding={false}
          elevation="medium"
        >
          {title && (
            <div className="btn-panel__header">
              <h4 id="btn-panel-title" className="btn-panel__title">
                {title}
              </h4>
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
            {panelContent}
          </div>
        </Card>
      )}

      {isOpen &&
        usePortal &&
        createPortal(
          <Card
            ref={panelRef}
            className={`${panelClasses} btn-panel--portal`}
            style={{
              ...getPanelStyle(),
              // top/left are written imperatively by the positioning effect
              position: "fixed",
              zIndex: "var(--z-modal)",
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? "btn-panel-title" : undefined}
            aria-label={!title ? ariaLabel : undefined}
            padding={false}
            elevation="medium"
          >
            {title && (
              <div className="btn-panel__header">
                <h4 id="btn-panel-title" className="btn-panel__title">
                  {title}
                </h4>
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
              {panelContent}
            </div>
          </Card>,
          document.body,
        )}
    </div>
  );
}
