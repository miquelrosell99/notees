/**
 * ContextMenu Component
 * 
 * A reusable context menu component that displays a list of actions
 * at the specified position. Uses the Card component for consistent styling.
 */
import React, { useRef, useEffect, useCallback, useState, type ReactNode } from 'react';
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
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  const [closingSubmenu, setClosingSubmenu] = useState(false);

  const closeSubmenuAnimated = useCallback(() => {
    setClosingSubmenu(true);
  }, []);

  // Get non-separator items for keyboard navigation
  const navigableItems = items.filter(item => !item.separator && !item.disabled);

  // Handle click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      // Don't close if clicking inside a portal opened from submenu content
      // (e.g. NodeSelector's dropdown portal which renders outside the menu Card)
      const floatingPortals = document.querySelectorAll('.node-selector__dropdown--portal');
      for (const portal of Array.from(floatingPortals)) {
        if (portal.contains(e.target as Node)) return;
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

  const handleItemClick = (item: ContextMenuItem) => {
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
          <React.Fragment key={item.id}>
            <button
              className={`context-menu-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''} ${isFocused ? 'focused' : ''} ${isActive || activeSubmenu === item.id ? 'active' : ''} ${item.submenu ? 'has-submenu' : ''}`}
              onClick={() => handleItemClick(item)}
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
          </React.Fragment>
        );
      })}
    </Card>
  );

  return inline ? menu : createPortal(menu, document.body);
}

export default ContextMenu;
