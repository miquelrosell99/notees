/**
 * ContextMenu Component
 *
 * A reusable context menu component that displays a list of actions
 * at the specified position.
 *
 * Rebuilt on the Radix context-menu/sub composition (the register's
 * scheduled migration, 2026-10-19): MenuPrimitive Content owns popper
 * positioning (viewport flip/shift/clamp replace the old imperative
 * fit), the roving-focus arrow-key walk, and the submenu flyout
 * placement. The fleet register stays fleet-owned per the sourcing
 * table — the surface/menu-item/submenu CSS hooks (ContextMenu.css),
 * the MDI icon chrome, the Escape LIFO ordering through the app overlay
 * stack (useOverlaySurface — Radix's own Escape is disabled via
 * onEscapeKeyDown preventDefault so the stack stays the single Escape
 * authority, the Modal-wrapper precedent), and the interaction
 * contracts that differ from Radix defaults:
 *
 * - Positioning rides a hidden ContextMenu.Trigger whose synthetic
 *   contextmenu event carries the anchor point (position prop) or the
 *   anchorEl rect — the app drives the menu open itself (callers render
 *   it on their own contextmenu gestures), so the Trigger is a pure
 *   virtual anchor, never a visible right-click target.
 * - Hover opens submenus on pointer-fine devices and click/tap toggles
 *   them everywhere, with an enter-only seam BETWEEN items (entering any
 *   other top-level item closes the open flyout) plus one leave rule at
 *   the card boundary: the pointer leaving the whole menu closes the
 *   flyout (owner report 2026-10-22 — a flyout lingered over the page
 *   after the pointer walked off the menu). The flyout rides flush
 *   against the menu edge as an inline DOM child of the card, so moving
 *   INTO it never leaves the card — pointerleave is geometric over the
 *   whole subtree: row → flyout keeps the pointer inside, row → page
 *   fires the close. The seam is driven here onMouseEnter/onMouseLeave
 *   rather than by Radix's pointermove/100ms hover, preserving the
 *   synchronous owner ruling (2026-10-16).
 * - Escape closes the active submenu first, then the menu, from the
 *   overlay stack regardless of where DOM focus is.
 * - Dismissal exceptions: pointer presses inside the icon/color picker
 *   popups (.ep--popup, .color-btn-picker), the caller's containerRef,
 *   or the anchor element itself (the anchor owns the toggle) keep the
 *   menu open.
 * - keepOpen items prevent the select default instead of closing.
 * - The flyout SubContent renders WITHOUT a Portal (inline child of the
 *   menu card, absolutely positioned) so it can never re-fit the menu's
 *   box and stays a DOM child of .context-menu (the feature-CSS and
 *   test contract).
 */
import {
  useRef,
  useEffect,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
  type FocusEvent,
  type MouseEvent,
  type RefObject,
} from 'react';

import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';

import { Separator } from './Separator.js';
import { useOverlaySurface } from './overlay-hooks.js';
import './ContextMenu.css';
import { Icon } from '../../../ui/Icon.js';
import { cn } from './cn.js';

export interface ContextMenuItem {
  id: string;
  label: string;
  /**
   * Optional hover tooltip (the native `title`) — the explanatory line for
   * a submenu variant row: what the action leaves behind, what follows
   * where. Kept off the visible row so the label stays short.
   */
  tooltip?: string | undefined;
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
  /**
   * If provided, shows a flyout submenu of action items to the side of the
   * parent row (the native action-list form — the whiteboard's `submenu`
   * is the custom-content form). Subitems fire their own onClick and then
   * close the whole menu (unless keepOpen).
   */
  submenuItems?: ContextMenuItem[] | undefined;
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
  /**
   * Marks the menu as an edit-session companion (data-editor-companion): the
   * contentEditable blur handler treats focus into the menu as staying inside
   * the editing session, so opening the menu never tears the editor down.
   */
  companion?: boolean | undefined;
}

export function ContextMenu({ items, position, anchorEl, onClose, title, activeItem, containerRef, inline = false, alignRight = false, className = '', companion = false }: ContextMenuProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  const posX = position?.x;
  const posY = position?.y;

  const closeSubmenu = useCallback(() => {
    setActiveSubmenu(null);
  }, []);

  // Hover opens submenus on pointer-fine devices only: on touch, the tap
  // must stay the explicit toggle (a synthesized mouseenter would open the
  // panel a moment before the click collapses it again).
  const canHover = useMemo(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: hover)').matches,
    [],
  );

  // Hover seam: entering a submenu parent opens its flyout; entering any
  // other top-level item closes the open one. Item-level enter handles the
  // BETWEEN-items case; the card-level leave (onMouseLeave on the Content)
  // closes the flyout when the pointer walks off the menu entirely — the
  // flyout is a DOM child of the card, so entering it never fires this.
  const handleItemEnter = useCallback(
    (item: ContextMenuItem) => {
      if (!canHover || item.disabled || item.separator) return;
      if (item.submenu !== undefined || item.submenuItems !== undefined) {
        if (activeSubmenu !== item.id) setActiveSubmenu(item.id);
      } else if (activeSubmenu !== null) {
        closeSubmenu();
      }
    },
    [canHover, activeSubmenu, closeSubmenu],
  );

  // Register with the overlay stack so Escape closes this context menu
  // (or its active submenu first) regardless of where DOM focus is.
  // Radix's own Escape handling is disabled on the Content/SubContent —
  // the stack is the single Escape authority across overlay surfaces.
  useOverlaySurface({
    type: 'popup',
    enabled: true,
    onClose,
    onEscape: () => {
      if (activeSubmenu) {
        closeSubmenu();
        return true;
      }
      return false;
    },
  });

  // Drive the hidden Trigger's internal virtual anchor: a synthetic
  // contextmenu event at the requested point (or the anchor element's
  // rect) is exactly how the Trigger itself opens, so the menu's popper
  // anchor lands where the app asked. The Trigger's virtual rect is a
  // zero-size POINT at the event coordinates, so the alignment edge IS
  // this x: the anchor's left edge for start-aligned menus, its right
  // edge for alignRight menus (the old imperative fit anchored the menu's
  // flush edge at the anchor rect). The Trigger's composed onContextMenu
  // calls preventDefault, so nothing leaks to the browser.
  useEffect(() => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const rect = anchorEl !== undefined && anchorEl !== null
      ? anchorEl.getBoundingClientRect()
      : null;
    const x = rect
      ? (alignRight ? rect.right : rect.left)
      : (posX ?? 0);
    const y = rect ? rect.bottom : (posY ?? 0);
    trigger.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      }),
    );
  }, [anchorEl, posX, posY, alignRight]);

  // Dismissal exceptions: presses inside the icon/color picker popovers,
  // the caller's container, or the anchor element (which owns the toggle)
  // must not close the menu.
  const isExceptionTarget = useCallback(
    (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (el === null || typeof el.closest !== 'function') return false;
      if (el.closest('.ep--popup, .color-btn-picker')) return true;
      if (containerRef?.current !== undefined && containerRef.current !== null && containerRef.current.contains(el)) {
        return true;
      }
      if (anchorEl !== undefined && anchorEl !== null && anchorEl.contains(el)) return true;
      return false;
    },
    [containerRef, anchorEl],
  );

  const handleInteractOutside = useCallback(
    (event: Event) => {
      if (isExceptionTarget(event.target)) event.preventDefault();
    },
    [isExceptionTarget],
  );

  // Shared row chrome: icon slot, label, badge, shortcut.
  const renderRowChrome = (item: ContextMenuItem): ReactNode => (
    <>
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
    </>
  );

  // A native submenu item: fires its own action, then notifies onClose
  // (unless keepOpen). The select default is ALWAYS prevented: this menu
  // is caller-controlled (open until the host unmounts it on onClose), so
  // the flyout stays put — the old contract the confirmation flows rely
  // on (the modal outlives the menu; the flyout lingers for a no-op
  // onClose).
  const renderSubitem = (sub: ContextMenuItem): ReactNode => {
    if (sub.separator) {
      return <Separator key={`sub-sep-${sub.id}`} orientation="horizontal" spacing="sm" />;
    }
    return (
      <ContextMenuPrimitive.Item
        key={sub.id}
        className={cn(
          'context-menu-item context-menu-subitem',
          sub.danger && 'danger',
          sub.disabled && 'disabled',
        )}
        disabled={sub.disabled === true}
        onSelect={(event) => {
          if (sub.disabled) return;
          event.preventDefault();
          sub.onClick?.();
          if (!sub.keepOpen) onClose();
        }}
        {...(sub.tooltip !== undefined ? { title: sub.tooltip } : {})}
      >
        {renderRowChrome(sub)}
      </ContextMenuPrimitive.Item>
    );
  };

  const renderItem = (item: ContextMenuItem, index: number): ReactNode => {
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

    const hasSubmenu = item.submenu !== undefined || item.submenuItems !== undefined;
    const isActive = activeItem === item.id;

    if (hasSubmenu) {
      // Controlled Sub: the open state is ours so the overlay stack's
      // Escape (submenu first) and the enter-only hover seam drive it
      // synchronously; Radix's own open/close requests (click toggle,
      // pointer leave) funnel through the same onOpenChange. The
      // SubContent renders WITHOUT a Portal — an inline, absolutely
      // positioned child of the menu card (never re-fits the menu's box,
      // stays under .context-menu for feature CSS) — and only WHILE the
      // state says open (`forceMount` + a conditional render): the DOM
      // lifecycle then rides our state, not Radix Presence's unmount
      // heuristic. That heuristic proved unreliable in the live browser
      // (owner report 2026-10-22: the flyout lingered, alternating
      // open/close cycles, with the Sub's data-state already "closed" —
      // Presence simply never detached the node; the jsdom suite cannot
      // catch it: jsdom models no animation lifecycle). No exit animation
      // is lost — the register carries enter-only panelFadeIn.
      const isOpen = activeSubmenu === item.id;
      return (
        <ContextMenuPrimitive.Sub
          key={item.id}
          open={isOpen}
          onOpenChange={(open) => setActiveSubmenu(open ? item.id : null)}
        >
          <ContextMenuPrimitive.SubTrigger
            className={cn(
              'context-menu-item has-submenu',
              item.danger && 'danger',
              item.disabled && 'disabled',
              (isActive || isOpen) && 'active',
            )}
            disabled={item.disabled === true}
            onMouseEnter={() => handleItemEnter(item)}
            {...(item.tooltip !== undefined ? { title: item.tooltip } : {})}
          >
            {renderRowChrome(item)}
            <span className="context-menu-arrow" aria-hidden="true">
              <Icon path="mdi-chevron-right" size={0.8} />
            </span>
          </ContextMenuPrimitive.SubTrigger>
          {isOpen && (
            <ContextMenuPrimitive.SubContent
              forceMount
              className="context-menu-submenu-flyout card"
              sideOffset={0}
              collisionPadding={VIEWPORT_PADDING}
              onEscapeKeyDown={(event) => event.preventDefault()}
              // Focus leaving the flyout (e.g. into a confirmation modal the
              // row spawned) must not close it — this menu is caller-
              // controlled; dismissal rides onClose, not focus (Radix's
              // default closes a sub on focus-outside).
              onFocusOutside={(event) => event.preventDefault()}
              onFocus={(e: FocusEvent) => e.stopPropagation()}
              onMouseDown={(e: MouseEvent) => e.stopPropagation()}
              onClick={(e: MouseEvent) => e.stopPropagation()}
            >
              {item.submenu !== undefined
                ? item.submenu
                : item.submenuItems!.map(renderSubitem)}
            </ContextMenuPrimitive.SubContent>
          )}
        </ContextMenuPrimitive.Sub>
      );
    }

    return (
      <ContextMenuPrimitive.Item
        key={item.id}
        className={cn(
          'context-menu-item',
          item.danger && 'danger',
          item.disabled && 'disabled',
          isActive && 'active',
        )}
        disabled={item.disabled === true}
        onSelect={(event) => {
          if (item.disabled) return;
          item.onClick?.();
          if (item.keepOpen) event.preventDefault();
        }}
        onMouseEnter={() => handleItemEnter(item)}
        {...(item.tooltip !== undefined ? { title: item.tooltip } : {})}
      >
        {renderRowChrome(item)}
      </ContextMenuPrimitive.Item>
    );
  };

  const menu = (
    <ContextMenuPrimitive.Content
      className={cn('context-menu card', className)}
      side="bottom"
      align={alignRight ? 'end' : 'start'}
      sideOffset={0}
      collisionPadding={VIEWPORT_PADDING}
      onEscapeKeyDown={(event) => event.preventDefault()}
      onPointerDownOutside={handleInteractOutside}
      onInteractOutside={handleInteractOutside}
      onMouseLeave={closeSubmenu}
      onFocus={(e: FocusEvent) => e.stopPropagation()}
      onMouseDown={(e: MouseEvent) => e.stopPropagation()}
      onClick={(e: MouseEvent) => e.stopPropagation()}
      {...(companion ? { 'data-editor-companion': 'true' } : {})}
    >
      {title && <div className="context-menu-title">{title}</div>}
      {items.map((item, index) => renderItem(item, index))}
    </ContextMenuPrimitive.Content>
  );

  return (
    <ContextMenuPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      modal={false}
    >
      {/* The hidden virtual anchor — see the positioning note in the
          header. Never a visible right-click target. */}
      <ContextMenuPrimitive.Trigger
        ref={triggerRef}
        aria-hidden="true"
        style={{ display: 'none' }}
      />
      {inline ? menu : (
        <ContextMenuPrimitive.Portal>{menu}</ContextMenuPrimitive.Portal>
      )}
    </ContextMenuPrimitive.Root>
  );
}
