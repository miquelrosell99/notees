/**
 * Bullet Component
 * 
 * A reusable bullet/dot element used in blocks and property values.
 * 
 * Features:
 * - Can be interactive (clickable, draggable) or decorative only
 * - Displays an icon instead of dot when provided
 * - Shows collapse arrow based on hasChildren and collapsed state
 * - Handles drag, click, shift+click, right-click events
 * - Shows outer ring when collapsed with children (like graph nodes)
 */
import { useCallback, useRef, useMemo } from 'react';
import { NodeIcon } from '@/components/ui/icons';
import './Bullet.css';

export type BulletSize = 'xs' | 'sm' | 'md';
export type BulletVariant = 'default' | 'interactive' | 'decorative';

export interface BulletProps {
  /** Node ID if attached to a node */
  nodeId?: number;
  /** Icon to display instead of the dot */
  icon?: string | null;
  /** Whether this is a page (affects icon display) */
  isPage?: boolean;
  /** Whether the bullet is interactive (clickable/draggable) or decorative only */
  interactive?: boolean;
  /** Whether the node has children */
  hasChildren?: boolean;
  /** Whether the node is collapsed */
  collapsed?: boolean;
  /** Whether this block is on the active editing path. */
  isActivePath?: boolean;
  /** If true and an icon is provided, render a small anchor dot for the bullet thread. */
  showMiniBullet?: boolean;
  /** Click handler (regular click - opens focused view) */
  onClick?: (e: React.MouseEvent) => void;
  /** Shift+click handler (opens in sidebar) */
  onShiftClick?: (nodeId: number) => void;
  /** Right-click/context menu handler */
  onContextMenu?: (nodeId: number, event: React.MouseEvent) => void;
  /** @dnd-kit activator ref for drag handle */
  activatorRef?: (element: HTMLElement | null) => void;
  /** @dnd-kit activator listeners for drag handle */
  activatorListeners?: Record<string, (event: React.SyntheticEvent) => void>;
  /** Whether currently dragging */
  isDragging?: boolean;
  /** Custom class name */
  className?: string;
  /** Title/tooltip */
  title?: string;
  /** Size variant */
  size?: BulletSize;
  /** Disable the default optical-offset nudge (used when the bullet is vertically centered). */
  disableOpticalOffset?: boolean;
  /** Whether this bullet belongs to a ghost pseudo-block. */
  isGhost?: boolean;
  /** Compact list-view size context (e.g. 'sm' for small list view). */
  listSize?: 'sm' | 'md';
  /** Whether this bullet is rendered inside a property text block editor. */
  inPropertyEditor?: boolean;
  /** Document mode: hide the bullet entirely. */
  documentMode?: boolean;
  /** When true, the dot is dimmed until the bullet is hovered. */
  dimmed?: boolean;
  /** Spacing to the right of the bullet (default gives a standard block gap). */
  spacing?: 'default' | 'none';
  /** When true, keeps the bullet fully visible in focus mode. */
  focusMode?: boolean;
}

export function Bullet({
  nodeId,
  icon,
  isPage = false,
  interactive = true,
  hasChildren = false,
  collapsed = false,
  isActivePath = false,
  showMiniBullet = false,
  onClick,
  onShiftClick,
  onContextMenu,
  activatorRef,
  activatorListeners,
  isDragging = false,
  className = '',
  title,
  size = 'sm',
  disableOpticalOffset = false,
  isGhost = false,
  listSize,
  inPropertyEditor,
  documentMode,
  dimmed,
  spacing = 'default',
  focusMode,
}: BulletProps) {
  const bulletRef = useRef<HTMLElement>(null);

  // Handle click on bullet
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!interactive) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    if (e.shiftKey && onShiftClick && nodeId) {
      onShiftClick(nodeId);
    } else if (onClick) {
      onClick(e);
    }
  }, [interactive, nodeId, onClick, onShiftClick]);
  
  // Handle context menu (right-click)
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!interactive || !nodeId || !onContextMenu) return;
    
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(nodeId, e);
  }, [interactive, nodeId, onContextMenu]);
  
  // Compute class names
  const classNames = useMemo(() => {
    const classes = ['bullet-wrapper', `bullet-${size}`];
    if (interactive) classes.push('bullet-interactive');
    if (collapsed) classes.push('bullet-collapsed');
    if (isDragging) classes.push('bullet-dragging');
    if (isActivePath) classes.push('bullet-active-path');
    if (showMiniBullet) classes.push('bullet-mini-bullet');
    if (icon) classes.push('bullet-has-icon');
    if (className) classes.push(className);
    return classes.join(' ');
  }, [size, interactive, collapsed, isDragging, isActivePath, showMiniBullet, icon, className]);
  
  // Compute title
  const computedTitle = useMemo(() => {
    if (title) return title;
    if (!interactive) return undefined;
    if (hasChildren && collapsed) return 'Drag to move, click to expand, Shift+click to open in sidebar';
    return 'Drag to move, click to focus, Shift+click to open in sidebar';
  }, [title, interactive, hasChildren, collapsed]);
  

  
  const Tag = interactive ? 'button' : 'div' as const;
  const buttonProps = interactive ? { type: 'button' as const } : {};

  return (
    <Tag
      ref={(el: HTMLElement | null) => {
        bulletRef.current = el;
        if (activatorRef) activatorRef(el as HTMLElement);
      }}
      className={classNames}
      onClick={interactive ? handleClick : undefined}
      onContextMenu={interactive ? handleContextMenu : undefined}
      {...(activatorListeners || {})}
      title={computedTitle}
      tabIndex={interactive ? 0 : -1}
      data-optical-offset={disableOpticalOffset ? 'false' : undefined}
      data-ghost={isGhost || undefined}
      data-list-size={listSize || undefined}
      data-property-editor={inPropertyEditor || undefined}
      data-document-mode={documentMode || undefined}
      data-dimmed={dimmed || undefined}
      data-spacing={spacing}
      data-focus-mode={focusMode || undefined}
      {...buttonProps}
    >
      {/* Bullet container */}
      <span className="bullet-container">
        {/* Outer ring - shows only when collapsed with children */}
        {hasChildren && collapsed && <span className="bullet-outer-ring" />}

        {/* Mini bullet anchor for icon bullets on the active editing path. */}
        {showMiniBullet && icon && <span className="bullet-mini" aria-hidden="true" />}

        {/* Icon or dot */}
        {icon ? (
          <NodeIcon icon={icon} isPage={isPage} size="xs" className="bullet-icon" />
        ) : (
          <span className="bullet-dot" />
        )}
      </span>
    </Tag>
  );
}

