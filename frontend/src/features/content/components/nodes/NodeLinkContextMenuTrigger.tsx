/**
 * NodeLinkContextMenuTrigger — wraps an inline link and opens the shared
 * NodeLinkContextMenu on right-click or long-press (touch).
 */
import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from 'react';
import {
  NodeLinkContextMenu,
  type NodeLinkContextMenuProps,
} from './NodeLinkContextMenu';

type NodeLinkContextMenuTriggerProps = Omit<
  NodeLinkContextMenuProps,
  'position' | 'onClose'
> & {
  children: ReactNode;
  className?: string;
};

const LONG_PRESS_MS = 600;
const MOVE_THRESHOLD_PX = 10;
const CLICK_SUPPRESS_MS = 500;

export function NodeLinkContextMenuTrigger({
  children,
  className,
  ...menuProps
}: NodeLinkContextMenuTriggerProps) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef({ x: 0, y: 0 });
  const suppressClickRef = useRef(false);
  const suppressTimeoutRef = useRef<number | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleClose = useCallback(() => {
    setMenuPos(null);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearSuppress = useCallback(() => {
    if (suppressTimeoutRef.current !== null) {
      window.clearTimeout(suppressTimeoutRef.current);
      suppressTimeoutRef.current = null;
    }
    suppressClickRef.current = false;
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLSpanElement>) => {
    clearSuppress();
    const touch = e.touches[0];
    if (!touch) return;

    startRef.current = { x: touch.clientX, y: touch.clientY };
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      suppressClickRef.current = true;
      suppressTimeoutRef.current = window.setTimeout(clearSuppress, CLICK_SUPPRESS_MS);
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: touch.clientX,
        clientY: touch.clientY,
        screenX: touch.clientX,
        screenY: touch.clientY,
        button: 2,
        buttons: 2,
      });
      e.currentTarget.dispatchEvent(event);
    }, LONG_PRESS_MS);
  }, [clearSuppress]);

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLSpanElement>) => {
    if (timerRef.current === null) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - startRef.current.x;
    const dy = touch.clientY - startRef.current.y;
    if (Math.hypot(dx, dy) > MOVE_THRESHOLD_PX) {
      clearTimer();
    }
  }, [clearTimer]);

  const handleTouchEnd = useCallback(() => {
    clearTimer();
  }, [clearTimer]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (suppressClickRef.current) {
      e.preventDefault();
      e.stopPropagation();
      clearSuppress();
    }
  }, [clearSuppress]);

  useEffect(() => {
    return () => {
      clearTimer();
      clearSuppress();
    };
  }, [clearTimer, clearSuppress]);

  return (
    <>
      {/* Wrapper for context menu / long-press; click handler only suppresses accidental taps after a hold. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <span
        className={className ?? 'node-link-context-menu-trigger'}
        onContextMenu={handleContextMenu}
        onClick={handleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {children}
      </span>
      {menuPos && (
        <NodeLinkContextMenu {...menuProps} position={menuPos} onClose={handleClose} />
      )}
    </>
  );
}
