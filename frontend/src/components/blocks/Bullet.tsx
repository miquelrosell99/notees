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
import { useCallback, useRef, useState, useMemo } from 'react';
import { NodeIcon, ChevronDownIcon, ChevronRightIcon } from '../icons';
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
  /** Whether the node has a cover image */
  hasCover?: boolean;
  /** Whether the block/node is being hovered */
  isHovered?: boolean;
  /** Whether to show the collapse arrow (can be controlled externally) */
  showCollapseArrow?: boolean;
  /** Click handler (regular click - opens focused view) */
  onClick?: (e: React.MouseEvent) => void;
  /** Shift+click handler (opens in sidebar) */
  onShiftClick?: (nodeId: number) => void;
  /** Right-click/context menu handler */
  onContextMenu?: (nodeId: number, event: React.MouseEvent) => void;
  /** Collapse toggle handler */
  onCollapseToggle?: (e: React.MouseEvent) => void;
  /** Drag start handler */
  onDragStart?: (e: React.DragEvent) => void;
  /** Whether the element is draggable */
  draggable?: boolean;
  /** Whether currently dragging */
  isDragging?: boolean;
  /** Custom class name */
  className?: string;
  /** Title/tooltip */
  title?: string;
  /** Size variant */
  size?: BulletSize;
}

export function Bullet({
  nodeId,
  icon,
  isPage = false,
  interactive = true,
  hasChildren = false,
  collapsed = false,
  hasCover = false,
  isHovered = false,
  showCollapseArrow: showCollapseArrowProp,
  onClick,
  onShiftClick,
  onContextMenu,
  onCollapseToggle,
  onDragStart,
  draggable = false,
  isDragging = false,
  className = '',
  title,
  size = 'sm',
}: BulletProps) {
  const bulletRef = useRef<HTMLDivElement>(null);
  const [showCollapseArrowInternal, setShowCollapseArrowInternal] = useState(false);
  
  // Use external prop if provided, otherwise use internal state
  const showCollapseArrow = showCollapseArrowProp !== undefined ? showCollapseArrowProp : showCollapseArrowInternal;
  
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
  
  // Handle collapse toggle click
  const handleCollapseClick = useCallback((e: React.MouseEvent) => {
    if (!onCollapseToggle) return;
    
    e.preventDefault();
    e.stopPropagation();
    onCollapseToggle(e);
  }, [onCollapseToggle]);
  
  // Handle drag start
  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (!interactive || !onDragStart) return;
    onDragStart(e);
  }, [interactive, onDragStart]);
  
  // Compute class names
  const classNames = useMemo(() => {
    const classes = ['bullet-wrapper', `bullet-${size}`];
    if (interactive) classes.push('bullet-interactive');
    if (hasChildren) classes.push('bullet-has-children');
    if (collapsed) classes.push('bullet-collapsed');
    if (hasCover) classes.push('bullet-has-cover');
    if (isDragging) classes.push('bullet-dragging');
    if (isHovered) classes.push('bullet-hovered');
    if (icon) classes.push('bullet-has-icon');
    if (className) classes.push(className);
    return classes.join(' ');
  }, [size, interactive, hasChildren, collapsed, hasCover, isDragging, isHovered, icon, className]);
  
  // Compute title
  const computedTitle = useMemo(() => {
    if (title) return title;
    if (!interactive) return undefined;
    if (hasChildren && collapsed) return 'Click to expand, Shift+click to open in sidebar';
    return 'Click to focus, Shift+click to open in sidebar';
  }, [title, interactive, hasChildren, collapsed]);
  
  // Show collapse arrow when hovering over bullet area if has children
  const handleMouseEnter = useCallback(() => {
    if (hasChildren && onCollapseToggle && showCollapseArrowProp === undefined) {
      setShowCollapseArrowInternal(true);
    }
  }, [hasChildren, onCollapseToggle, showCollapseArrowProp]);
  
  const handleMouseLeave = useCallback(() => {
    if (showCollapseArrowProp === undefined) {
      setShowCollapseArrowInternal(false);
    }
  }, [showCollapseArrowProp]);
  
  return (
    <div
      ref={bulletRef}
      className={classNames}
      onClick={interactive ? handleClick : undefined}
      onContextMenu={interactive ? handleContextMenu : undefined}
      onDragStart={interactive ? handleDragStart : undefined}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      draggable={draggable}
      title={computedTitle}
      role={interactive ? 'button' : 'presentation'}
      tabIndex={interactive ? 0 : -1}
    >
      {/* Collapse arrow - shown when hovered and has children */}
      {hasChildren && onCollapseToggle && (showCollapseArrow || isHovered) && (
        <button
          className="bullet-collapse-arrow"
          onClick={handleCollapseClick}
          title={collapsed ? 'Expand' : 'Collapse'}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronRightIcon size="xs" /> : <ChevronDownIcon size="xs" />}
        </button>
      )}
      
      {/* Cover indicator - shown to the left of bullet when node has cover */}
      {hasCover && <span className="bullet-cover-indicator" title="Has cover image" />}
      
      {/* Bullet container */}
      <span className="bullet-container">
        {/* Outer ring - shows on hover or when collapsed with children */}
        {(interactive || (hasChildren && collapsed)) && <span className="bullet-outer-ring" />}
        
        {/* Icon or dot */}
        {icon ? (
          <NodeIcon icon={icon} isPage={isPage} size="xs" className="bullet-icon" />
        ) : (
          <span className="bullet-dot" />
        )}
      </span>
    </div>
  );
}

export default Bullet;
