/**
 * QuerySection Component
 * 
 * A section wrapper that combines QueryNodeCollection with NodeViewSection.
 * Used for displaying query-based sections on pages (linked refs, child pages, etc.)
 */
import { useState, useCallback } from 'react';
import { QueryNodeCollection } from './QueryNodeCollection';
import { ChevronRightIcon, ChevronDownIcon } from '../icons';
import { Button } from '../core/Button';
import type { NodeViewType } from '@/types/query';
import './NodeViewSection.css';

export interface QuerySectionProps {
  /** The node ID to display views for */
  nodeId: number;
  /** The node UUID for query placeholders */
  nodeUuid: string;
  /** The view type (e.g., 'linked_references', 'child_pages') */
  viewType: NodeViewType | string;
  /** Section title */
  title: string;
  /** Icon for the section header */
  icon?: React.ReactNode;
  /** Whether to hide section when no results */
  hideWhenEmpty?: boolean;
  /** Default expanded state */
  defaultExpanded?: boolean;
  /** Callback when a node is clicked */
  onNodeClick?: (nodeId: number, isPage?: boolean) => void;
  /** Callback when a block is created (for opening in sidebar) */
  onBlockCreated?: (nodeId: number) => void;
  /** Additional CSS class */
  className?: string;
}

export function QuerySection({
  nodeId,
  nodeUuid,
  viewType,
  title,
  icon,
  hideWhenEmpty = true,
  defaultExpanded = true,
  onNodeClick,
  onBlockCreated,
  className = '',
}: QuerySectionProps): React.JSX.Element | null {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  
  const handleToggle = useCallback(() => {
    setIsExpanded(prev => !prev);
  }, []);

  return (
    <QueryNodeCollection
      nodeId={nodeId}
      nodeUuid={nodeUuid}
      viewType={viewType}
      onNodeClick={onNodeClick}
      onBlockCreated={onBlockCreated}
      showAddButton={viewType !== 'linked_references'}
      hideToolbarControls={!isExpanded}
      hideContent={!isExpanded}
      leftElement={(count) => (
        <div className="node-view-section__header-content" onClick={handleToggle}>
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
            <h3 className="node-view-section__title">{title}</h3>
            {count !== undefined && (
              <span className="node-view-section__count">({count})</span>
            )}
          </div>
        </div>
      )}
    >
      {({ results, count, isLoading }) => {
        // Hide section if empty and hideWhenEmpty is true
        if (hideWhenEmpty && !isLoading && count === 0) {
          return null;
        }

        return (
          <section className={`node-view-section ${isExpanded ? 'expanded' : 'collapsed'} query-section ${className}`}>
            {/* Always render results (includes toolbar with header) */}
            {results}
          </section>
        );
      }}
    </QueryNodeCollection>
  );
}

export default QuerySection;
