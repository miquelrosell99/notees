/**
 * CollapseArrow Component
 * 
 * A reusable collapse/expand arrow button used in blocks and table rows.
 * Positioned absolutely to the left of the parent element.
 * 
 * Features:
 * - Only visible on hover (over a circular hit area)
 * - Chevron icon rotates based on collapsed state
 * - Consistent styling across blocks and tables
 */
import { useCallback } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '../icons';
import './CollapseArrow.css';

export type CollapseArrowSize = 'xs' | 'sm' | 'md';

export interface CollapseArrowProps {
  /** Whether the content is collapsed */
  collapsed: boolean;
  /** Toggle callback */
  onToggle: (e: React.MouseEvent) => void;
  /** Size variant */
  size?: CollapseArrowSize;
  /** Whether to always show (vs only on hover) */
  alwaysVisible?: boolean;
  /** Whether the arrow is currently visible (controlled externally) */
  visible?: boolean;
  /** Additional className */
  className?: string;
}

export function CollapseArrow({
  collapsed,
  onToggle,
  size = 'sm',
  alwaysVisible = false,
  visible = true,
  className = '',
}: CollapseArrowProps) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onToggle(e);
  }, [onToggle]);

  const classNames = [
    'collapse-arrow',
    `collapse-arrow--${size}`,
    alwaysVisible ? 'collapse-arrow--always-visible' : '',
    visible ? 'collapse-arrow--visible' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button
      className={classNames}
      onClick={handleClick}
      title={collapsed ? 'Expand' : 'Collapse'}
      aria-label={collapsed ? 'Expand' : 'Collapse'}
      aria-expanded={!collapsed}
    >
      {collapsed ? <ChevronRightIcon size={size} /> : <ChevronDownIcon size={size} />}
    </button>
  );
}
