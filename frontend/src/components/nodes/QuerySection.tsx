/**
 * QuerySection Component
 * 
 * A section wrapper that combines QueryNodeCollection with NodeViewSection.
 * Used for displaying query-based sections on pages (linked refs, child pages, etc.)
 */
import { useState, useCallback } from 'react';
import { QueryNodeCollection } from './QueryNodeCollection';
import { ChevronRightIcon, ChevronDownIcon } from '@/components/core/icons';
import { Button } from '@/components/core/Button';
import { LoadingSkeleton } from '@/components/core/LoadingSkeleton';
import type { NodeViewType } from '@/types/nodeView';
import type { QueryAST } from '@/types/queryAST';
import './NodeViewSection.css';

export interface QuerySectionProps {
  /** The node ID to display views for */
  nodeId: number;
  /** The node UUID for query placeholders */
  nodeUuid: string;
  /** The node name (used to include the active node in graph views) */
  nodeName?: string;
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
  /** Hide view management controls (view selector, filter button, add view button) */
  hideViewManagement?: boolean;
  /** Whether new items can be created (default: true) */
  can_create?: boolean;
  /** Whether to show class pills in list view (default: true) */
  showClasses?: boolean;
  /**
   * Inline query AST for ad-hoc queries (bypasses saved views).
   * Must be paired with onQueryASTChange to enable inline mode.
   */
  queryAST?: QueryAST;
  /** Called when the user modifies the inline query AST */
  onQueryASTChange?: (ast: QueryAST) => void;
}

export function QuerySection({
  nodeId,
  nodeUuid,
  nodeName,
  viewType,
  title,
  icon,
  hideWhenEmpty = true,
  defaultExpanded = true,
  onNodeClick,
  onBlockCreated,
  className = '',
  hideViewManagement = false,
  can_create = true,
  showClasses = true,
  queryAST,
  onQueryASTChange,
}: QuerySectionProps): React.JSX.Element | null {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  
  const handleToggle = useCallback(() => {
    setIsExpanded(prev => !prev);
  }, []);

  const renderHeader = useCallback((count?: number) => (
    <div role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }} className="node-view-section__header-content" onClick={handleToggle}>
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
  ), [isExpanded, handleToggle, icon, title]);

  return (
    <QueryNodeCollection
      nodeId={nodeId}
      nodeUuid={nodeUuid}
      nodeName={nodeName}
      viewType={viewType}
      onNodeClick={onNodeClick}
      onBlockCreated={onBlockCreated}
      showAddButton={viewType !== 'linked_references'}
      hideToolbarControls={!isExpanded}
      hideContent={!isExpanded}
      hideViewManagement={hideViewManagement}
      can_create={can_create}
      showClasses={showClasses}
      queryAST={queryAST}
      onQueryASTChange={onQueryASTChange}
      leftElement={renderHeader}
    >
      {({ results, count, isLoading }) => {
        // Hide section if empty and hideWhenEmpty is true
        if (hideWhenEmpty && !isLoading && count === 0) {
          return null;
        }

        // Show header + skeleton while views/query are initializing (results not yet available)
        if (isLoading && !results) {
          return (
            <section className={`node-view-section ${isExpanded ? 'expanded' : 'collapsed'} query-section ${className}`}>
              {renderHeader()}
              <LoadingSkeleton rows={2} className="query-section__skeleton" />
            </section>
          );
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

