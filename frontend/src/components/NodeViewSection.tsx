/**
 * NodeViewSection Component
 * 
 * A reusable collapsible section component for NodeView.
 * Used for:
 * - Typed nodes (nodes with this type)
 * - Child pages
 * - Linked references
 * - Activity log
 */
import { useState, useCallback, type ReactNode } from 'react';
import { ChevronRightIcon, ChevronDownIcon } from './icons';
import './NodeViewSection.css';

export interface NodeViewSectionProps {
  /** Section title */
  title: string;
  /** Icon to display before title */
  icon?: ReactNode;
  /** Item count to display */
  count?: number;
  /** Whether section is expanded by default */
  defaultExpanded?: boolean;
  /** Content to render inside the section */
  children: ReactNode;
  /** Extra actions/buttons for the header right side */
  headerActions?: ReactNode;
  /** Additional CSS class */
  className?: string;
  /** Whether to hide the section when empty (count === 0) */
  hideWhenEmpty?: boolean;
}

export function NodeViewSection({
  title,
  icon,
  count,
  defaultExpanded = true,
  children,
  headerActions,
  className = '',
  hideWhenEmpty = false,
}: NodeViewSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  
  const handleToggle = useCallback(() => {
    setIsExpanded(prev => !prev);
  }, []);
  
  // Hide section when empty if requested
  if (hideWhenEmpty && (count === 0 || count === undefined)) {
    return null;
  }
  
  return (
    <section className={`node-view-section ${isExpanded ? 'expanded' : 'collapsed'} ${className}`}>
      <header className="node-view-section__header" onClick={handleToggle}>
        <button 
          className="node-view-section__toggle"
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Collapse section' : 'Expand section'}
        >
          {isExpanded ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />}
        </button>
        
        <div className="node-view-section__title-area">
          {icon && <span className="node-view-section__icon">{icon}</span>}
          <h3 className="node-view-section__title">{title}</h3>
          {count !== undefined && (
            <span className="node-view-section__count">({count})</span>
          )}
        </div>
        
        {headerActions && (
          <div className="node-view-section__actions" onClick={e => e.stopPropagation()}>
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

export default NodeViewSection;
