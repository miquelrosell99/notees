/**
 * NodeViewSection Component
 * 
 * A reusable collapsible section component for NodeView.
 * Used for:
 * - Typed nodes (nodes with this type)
 * - Child pages
 * - Linked references
 * - Activity log
 * 
 * Supports both controlled and uncontrolled modes:
 * - Uncontrolled: Use defaultExpanded for initial state
 * - Controlled: Use expanded + onExpandedChange for external control
 */
import { useState, useCallback, type ReactNode } from 'react';
import { ChevronRightIcon, ChevronDownIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import './NodeViewSection.css';

export interface NodeViewSectionProps {
  /** Section title */
  title: string;
  /** Icon to display before title */
  icon?: ReactNode;
  /** Item count to display */
  count?: number;
  /** Whether section is expanded by default (uncontrolled mode) */
  defaultExpanded?: boolean;
  /** Controlled expanded state - when provided, component is controlled */
  expanded?: boolean;
  /** Callback when expanded state changes (for controlled mode) */
  onExpandedChange?: (expanded: boolean) => void;
  /** Content to render inside the section */
  children: ReactNode;
  /** Extra actions/buttons for the header right side */
  headerActions?: ReactNode;
  /** Additional CSS class */
  className?: string;
  /** Whether to hide the section when empty (count === 0) */
  hideWhenEmpty?: boolean;
  /** Visual variant. */
  variant?: 'default' | 'sidebar' | 'sidebar-node' | 'backlink';
  /** When true, hides the entire section (used by focus mode). */
  focusMode?: boolean;
}

export function NodeViewSection({
  title,
  icon,
  count,
  defaultExpanded = true,
  expanded,
  onExpandedChange,
  children,
  headerActions,
  className = '',
  hideWhenEmpty = false,
  variant = 'default',
  focusMode = false,
}: NodeViewSectionProps) {
  // Support both controlled and uncontrolled modes
  const isControlled = expanded !== undefined;
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const isExpanded = isControlled ? expanded : internalExpanded;
  
  const handleToggle = useCallback(() => {
    if (isControlled) {
      onExpandedChange?.(!expanded);
    } else {
      setInternalExpanded(prev => !prev);
    }
  }, [isControlled, expanded, onExpandedChange]);
  
  // Hide section when empty if requested
  if (hideWhenEmpty && (count === 0 || count === undefined)) {
    return null;
  }
  
  return (
    <section
      className={`node-view-section ${isExpanded ? 'expanded' : 'collapsed'} ${className}`}
      data-variant={variant}
      data-focus-mode={focusMode || undefined}
    >
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- The header is a pointer-only toggle; keyboard users can use the visible expand/collapse button inside it. */}
      <header
        className="node-view-section__header"
        onClick={handleToggle}
      >
        <Button
          variant="ghost"
          size="xs"
          className="node-view-section__toggle"
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Collapse section' : 'Expand section'}
        >
          {isExpanded ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />}
        </Button>

        <div className="node-view-section__title-area">
          {icon && <span className="node-view-section__icon">{icon}</span>}
          <h2 className="node-view-section__title">{title}</h2>
          {count !== undefined && (
            <span className="node-view-section__count">({count})</span>
          )}
        </div>

        {headerActions && (
          <div className="node-view-section__actions" onClickCapture={e => e.stopPropagation()}>
            {headerActions}
          </div>
        )}
      </header>
      
      {isExpanded && (
        <div className="node-view-section__content">
          {children}
        </div>
      )}
    </section>
  );
}

