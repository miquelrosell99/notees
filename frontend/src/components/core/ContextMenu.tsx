/**
 * ContextMenu Component
 * 
 * A reusable context menu component that displays a list of actions
 * at the specified position. Uses the Card component for consistent styling.
 */
import { useRef, useEffect, useCallback, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Icon from '@mdi/react';
import { Card } from './Card';
import { Separator } from './Separator';
import './ContextMenu.css';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  /** If true, don't close the menu when this item is clicked */
  keepOpen?: boolean;
  /** If provided, shows a submenu with custom content when item is clicked */
  submenu?: ReactNode;
  /** If provided, renders custom content directly in the menu row instead of a button */
  content?: ReactNode;
  onClick?: () => void;
}

export interface ContextMenuAnchor {
  /** Anchor element for positioning */
  element?: HTMLElement | null;
  /** Or explicit position */
  position?: { x: number; y: number };
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
  /** Optional title for the menu */
  title?: string;
  /** Active/anchor item for positioning reference */
  activeItem?: string;
  /** Optional container ref - clicks inside this container won't close the menu */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** When true, render inline (no portal) — for use inside an already-portaled wrapper */
  inline?: boolean;
}

export function ContextMenu({ items, position, onClose, title, activeItem, containerRef, inline = false }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [submenuInitialPos, setSubmenuInitialPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Get non-separator items for keyboard navigation
  const navigableItems = items.filter(item => !item.separator && !item.disabled);

  // Handle click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      // Don't close if clicking inside submenu
      const submenuEl = document.querySelector('.context-menu-submenu');
      if (submenuEl && submenuEl.contains(e.target as Node)) {
        return;
      }
      // Don't close if clicking inside container (e.g., color picker row)
      if (containerRef?.current && containerRef.current.contains(e.target as Node)) {
        return;
      }
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
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
        e.preventDefault();
        const item = navigableItems[focusedIndex];
        if (item && !item.disabled) {
          item.onClick?.();
          if (!item.keepOpen) {
            onClose();
          }
        }
      }
    };

    // Use both mousedown and click to ensure we catch outside clicks
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('click', handleClickOutside, true);
    document.addEventListener('keydown', handleEscape);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('click', handleClickOutside, true);
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, navigableItems, focusedIndex, containerRef]);

  // Adjust position to stay within viewport via callback ref
  const menuCallbackRef = useCallback((el: HTMLDivElement | null) => {
    menuRef.current = el;
    if (!el) return;
    // Set initial position
    el.style.left = `${position.x}px`;
    el.style.top = `${position.y}px`;
    // Measure and adjust
    const menuRect = el.getBoundingClientRect();
    const padding = 8;
    let x = position.x;
    let y = position.y;
    if (x + menuRect.width > window.innerWidth) {
      x = window.innerWidth - menuRect.width - padding;
    }
    if (y + menuRect.height > window.innerHeight) {
      y = position.y - menuRect.height;
    }
    if (x < padding) x = padding;
    if (y < padding) y = padding;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [position]);

  // Adjust submenu position to stay within viewport
  useEffect(() => {
    if (!activeSubmenu || !submenuRef.current) return;

    const submenuRect = submenuRef.current.getBoundingClientRect();
    const padding = 8;
    
    let x = submenuInitialPos.x;
    let y = submenuInitialPos.y;

    // Check right edge - if submenu goes off screen, show it on the left side instead
    if (x + submenuRect.width > window.innerWidth) {
      // Position to the left of the parent menu
      if (menuRef.current) {
        const menuRect = menuRef.current.getBoundingClientRect();
        x = menuRect.left - submenuRect.width - 4;
      }
    }
    // Check bottom edge
    if (y + submenuRect.height > window.innerHeight) {
      y = window.innerHeight - submenuRect.height - padding;
    }
    // Check left edge
    if (x < padding) {
      x = padding;
    }
    // Check top edge
    if (y < padding) {
      y = padding;
    }

    setSubmenuPosition({ x, y });
  }, [activeSubmenu, submenuInitialPos]);

  const handleItemClick = (item: ContextMenuItem, event?: React.MouseEvent<HTMLButtonElement>) => {
    if (item.disabled || item.separator) return;
    
    // If item has submenu, toggle it
    if (item.submenu) {
      if (activeSubmenu === item.id) {
        setActiveSubmenu(null);
      } else {
        // Calculate submenu position next to this item
        const buttonEl = event?.currentTarget;
        if (buttonEl) {
          const rect = buttonEl.getBoundingClientRect();
          const initialPos = { 
            x: rect.right + 4, 
            y: rect.top 
          };
          setSubmenuInitialPos(initialPos);
          setSubmenuPosition(initialPos);
        }
        setActiveSubmenu(item.id);
      }
      return;
    }
    
    item.onClick?.();
    if (!item.keepOpen) {
      onClose();
    }
  };

  // Track index in navigable items for focus
  let navigableIndex = -1;

  const menu = (
    <Card
      ref={menuCallbackRef}
      className="context-menu"
      role="menu"
      elevation="high"
      padding={false}
      onFocus={(e: React.FocusEvent) => e.stopPropagation()}
      onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
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
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {item.content}
            </div>
          );
        }

        navigableIndex++;
        const isFocused = navigableIndex === focusedIndex;
        const isActive = activeItem === item.id;

        return (
          <button
            key={item.id}
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
            {item.shortcut && (
              <span className="context-menu-shortcut">{item.shortcut}</span>
            )}
            {item.submenu && (
              <span className="context-menu-arrow">›</span>
            )}
          </button>
        );
      })}
      {activeSubmenu && (
        <div 
          ref={submenuRef}
          className="context-menu-submenu"
          style={{ left: submenuPosition.x, top: submenuPosition.y }}
        >
          {items.find(item => item.id === activeSubmenu)?.submenu}
        </div>
      )}
    </Card>
  );

  return inline ? menu : createPortal(menu, document.body);
}

export default ContextMenu;
