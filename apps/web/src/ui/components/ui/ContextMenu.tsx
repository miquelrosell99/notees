/**
 * ContextMenu Component
 *
 * A reusable context menu component that displays a list of actions
 * at the specified position. Uses the Card component for consistent styling.
 */
import {
  Fragment,
  useRef,
  useEffect,
  useCallback,
  useLayoutEffect,
  useState,
  type ReactNode,
  type MouseEvent,
  type FocusEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import { Card } from './Card.js';
import { Separator } from './Separator.js';
import { useOverlaySurface, observeResizes } from './overlay-hooks.js';
import './ContextMenu.css';
import { Icon } from '../../Icon.js';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: string | undefined;
  shortcut?: string | undefined;
  badge?: string | undefined;
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
  separator?: boolean | undefined;
  /** If true, don't close the menu when this item is clicked */
  keepOpen?: boolean | undefined;
  /** If provided, shows a submenu with custom content when item is clicked */
  submenu?: ReactNode | undefined;
  /** If provided, renders custom content directly in the menu row instead of a button */
  content?: ReactNode | undefined;
  onClick?: ((event?: MouseEvent) => void) | undefined;
}

export interface ContextMenuAnchor {
  /** Anchor element for positioning */
  element?: HTMLElement | null | undefined;
  /** Or explicit position */
  position?: { x: number; y: number } | undefined;
}

/** Minimum clearance from the menu to the viewport edge. */
const VIEWPORT_PADDING = 8;

export interface ContextMenuProps {
  items: ContextMenuItem[];
  /** Explicit screen position (fallback when anchorEl is not provided) */
  position?: { x: number; y: number } | undefined;
  /** Anchor element — menu is positioned relative to this element's rect */
  anchorEl?: HTMLElement | null | undefined;
  onClose: () => void;
  /** Optional title for the menu */
  title?: string | undefined;
  /** Active/anchor item for positioning reference */
  activeItem?: string | undefined;
  /** Optional container ref - clicks inside this container won't close the menu */
  containerRef?: RefObject<HTMLElement | null> | undefined;
  /** When true, render inline (no portal) — for use inside an already-portaled wrapper */
  inline?: boolean | undefined;
  /** When true, menu aligns to the right edge of the anchor/position */
  alignRight?: boolean | undefined;
  /** Additional class applied to the menu root (alongside context-menu). */
  className?: string | undefined;
}

export function ContextMenu({ items, position, anchorEl, onClose, title, activeItem, containerRef, inline = false, alignRight = false, className = '' }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  const [closingSubmenu, setClosingSubmenu] = useState(false);
  const posX = position?.x;
  const posY = position?.y;

  const closeSubmenuAnimated = useCallback(() => {
    setClosingSubmenu(true);
  }, []);

  // Register with the overlay stack so Escape closes this context menu
  // (or its active submenu first) regardless of where DOM focus is.
  useOverlaySurface({
    type: 'popup',
    enabled: true,
    onClose,
    onEscape: () => {
      if (activeSubmenu) {
        closeSubmenuAnimated();
        return true;
      }
      return false;
    },
  });

  // Get keyboard-navigable items (the buttons rendered in the menu;
  // separators, disabled items, and custom content rows are skipped)
  const navigableItems = items.filter(item => !item.separator && !item.disabled && !item.content);

  const handleItemClick = useCallback((item: ContextMenuItem, event?: MouseEvent) => {
    if (item.disabled || item.separator) return;

    // If item has submenu, toggle it
    if (item.submenu) {
      if (activeSubmenu === item.id) {
        closeSubmenuAnimated();
      } else {
        setActiveSubmenu(item.id);
        setClosingSubmenu(false);
      }
      return;
    }

    item.onClick?.(event);
    if (!item.keepOpen) {
      onClose();
    }
  }, [activeSubmenu, closeSubmenuAnimated, onClose]);

  // Handle click outside
  useEffect(() => {
    const handleClickOutside = (e: globalThis.MouseEvent) => {
      // Don't close if clicking inside emoji picker or color picker popovers
      const pickerPopups = document.querySelectorAll('.ep--popup, .color-btn-picker');
      for (const popup of Array.from(pickerPopups)) {
        if (popup.contains(e.target as Node)) return;
      }
      // Don't close if clicking inside container (e.g., color picker row)
      if (containerRef?.current && containerRef.current.contains(e.target as Node)) {
        return;
      }
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex(prev =>
          prev < navigableItems.length - 1 ? prev + 1 : 0
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex(prev =>
          prev > 0 ? prev - 1 : navigableItems.length - 1
        );
      } else if (e.key === 'Enter' && focusedIndex >= 0) {
        // preventDefault also suppresses the focused button's native click,
        // so the item is activated exactly once.
        e.preventDefault();
        const item = navigableItems[focusedIndex];
        if (item) {
          handleItemClick(item);
        }
      }
    };

    // Use both mousedown and click to ensure we catch outside clicks
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('click', handleClickOutside, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('click', handleClickOutside, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, navigableItems, focusedIndex, containerRef, handleItemClick]);

  // Move real DOM focus to the keyboard-navigated item so it is announced by
  // screen readers, and keep it scrolled into view.
  useEffect(() => {
    if (focusedIndex < 0) return;
    const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>(
      '.context-menu-item:not(:disabled)',
    );
    const el = buttons?.[focusedIndex];
    if (el) {
      el.focus();
      el.scrollIntoView?.({ block: 'nearest' });
    }
  }, [focusedIndex]);

  // Position the menu relative to the anchor element (or an explicit point)
  // and keep it inside the viewport (flip above, shift sideways). Styles are
  // written straight to the menu element, so repositioning never goes through
  // React renders. Scroll (window), viewport resize, and element resize
  // re-trigger positioning.
  useLayoutEffect(() => {
    const floating = menuRef.current;
    if (!floating) return;

    const alignment = alignRight ? 'end' : 'start';

    // Portal mode renders position:fixed (see ContextMenu.css); inline mode
    // positions absolutely within its offset parent. The position style is
    // written imperatively so the strategy always matches the element.
    const strategy = inline ? 'absolute' : 'fixed';

    const getReferenceRect = (): DOMRect => {
      if (anchorEl) return anchorEl.getBoundingClientRect();
      const x = posX ?? 0;
      const y = posY ?? 0;
      return { x, y, width: 0, height: 0, top: y, left: x, right: x, bottom: y, toJSON: () => ({}) } as DOMRect;
    };

    const update = () => {
      // Re-read the anchor rect on every reposition so the menu follows a
      // moving/scrolled anchor.
      const referenceRect = getReferenceRect();
      const floatingW = floating.offsetWidth;
      const floatingH = floating.offsetHeight;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;

      const scrollX = strategy === 'fixed' ? 0 : window.scrollX;
      const scrollY = strategy === 'fixed' ? 0 : window.scrollY;

      // Vertical: prefer below the anchor (or the point), flip above when
      // there is not enough room and more space on top.
      const spaceBelow = viewportH - referenceRect.bottom - VIEWPORT_PADDING;
      const spaceAbove = referenceRect.top - VIEWPORT_PADDING;
      let y: number;
      if (spaceBelow < floatingH && spaceAbove > spaceBelow) {
        y = referenceRect.top - floatingH;
      } else {
        y = referenceRect.bottom;
      }
      y = Math.min(Math.max(y, VIEWPORT_PADDING), Math.max(VIEWPORT_PADDING, viewportH - floatingH - VIEWPORT_PADDING));

      // Horizontal: start (left) or end (right) aligned, then clamp.
      let x: number;
      if (alignment === 'end') {
        x = referenceRect.right - floatingW;
      } else {
        x = referenceRect.left;
      }
      x = Math.min(Math.max(x, VIEWPORT_PADDING), Math.max(VIEWPORT_PADDING, viewportW - floatingW - VIEWPORT_PADDING));

      floating.style.position = strategy;
      floating.style.left = `${x + scrollX}px`;
      floating.style.top = `${y + scrollY}px`;
      floating.style.right = 'auto';
      floating.style.bottom = 'auto';
      floating.style.visibility = 'visible';
    };

    update();

    const handleReposition = () => update();
    window.addEventListener('scroll', handleReposition, { capture: true, passive: true });
    window.addEventListener('resize', handleReposition);
    const unobserve = observeResizes([anchorEl, floating], handleReposition);

    return () => {
      window.removeEventListener('scroll', handleReposition, { capture: true });
      window.removeEventListener('resize', handleReposition);
      unobserve();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reference rect is re-read on every update cycle
  }, [anchorEl, posX, posY, alignRight, inline]);

  // Track index in navigable items for focus
  let navigableIndex = -1;

  const menu = (
    <Card
      ref={menuRef}
      className={`context-menu ${className}`}
      // Hidden until positioned (visibility is flipped to visible imperatively
      // after the first layout pass).
      style={{ visibility: 'hidden' }}
      role="menu"
      elevation="high"
      radius="floating"
      padding={false}
      onFocus={(e: FocusEvent) => e.stopPropagation()}
      onMouseDown={(e: MouseEvent) => e.stopPropagation()}
      onClick={(e: MouseEvent) => e.stopPropagation()}
    >
      {title && <div className="context-menu-title">{title}</div>}
      {items.map((item, index) => {
        if (item.separator) {
          return <Separator key={`sep-${index}`} orientation="horizontal" spacing="sm" />;
        }

        if (item.content) {
          return (
            <div
              key={item.id}
              className="context-menu-content-row"
            >
              {item.content}
            </div>
          );
        }

        navigableIndex++;
        const isFocused = navigableIndex === focusedIndex;
        const isActive = activeItem === item.id;

        return (
          <Fragment key={item.id}>
            <button
              className={`context-menu-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''} ${isFocused ? 'focused' : ''} ${isActive || activeSubmenu === item.id ? 'active' : ''} ${item.submenu ? 'has-submenu' : ''}`}
              onClick={(e) => handleItemClick(item, e)}
              disabled={item.disabled}
              role="menuitem"
              tabIndex={isFocused ? 0 : -1}
            >
              <span className="context-menu-icon-wrapper">
                {item.icon && (
                  <Icon path={item.icon} size={0.7} className="context-menu-icon" />
                )}
              </span>
              <span className="context-menu-label">{item.label}</span>
              {item.badge && (
                <span className="context-menu-badge">{item.badge}</span>
              )}
              {item.shortcut && (
                <span className="context-menu-shortcut">{item.shortcut}</span>
              )}
              {item.submenu && (
                <span className={`context-menu-arrow${activeSubmenu === item.id ? ' context-menu-arrow--open' : ''}`}>›</span>
              )}
            </button>
            {item.submenu && activeSubmenu === item.id && (
              <div
                className={`context-menu-submenu-inline${closingSubmenu ? ' context-menu-submenu-inline--closing' : ''}`}
                onAnimationEnd={() => {
                  if (closingSubmenu) {
                    setActiveSubmenu(null);
                    setClosingSubmenu(false);
                  }
                }}
              >
                {item.submenu}
              </div>
            )}
          </Fragment>
        );
      })}
    </Card>
  );

  return inline ? menu : createPortal(menu, document.body);
}
