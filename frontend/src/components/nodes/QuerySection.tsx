/**
 * QuerySection Component
 * 
 * A section wrapper that combines QueryNodeCollection with NodeViewSection.
 * Used for displaying query-based sections on pages (linked refs, child pages, etc.)
 */
import { QueryNodeCollection } from './QueryNodeCollection';
import { NodeViewSection } from './NodeViewSection';
import type { NodeViewType } from '@/types/query';

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
  return (
    <QueryNodeCollection
      nodeId={nodeId}
      nodeUuid={nodeUuid}
      viewType={viewType}
      onNodeClick={onNodeClick}
      onBlockCreated={onBlockCreated}
      showAddButton={viewType !== 'linked_references'}
    >
      {({ controls, results, count, isLoading }) => {
        // Hide section if empty and hideWhenEmpty is true
        if (hideWhenEmpty && !isLoading && count === 0) {
          return null;
        }

        return (
          <NodeViewSection
            title={title}
            icon={icon}
            count={count}
            defaultExpanded={defaultExpanded}
            hideWhenEmpty={false}
            headerActions={controls}
            className={`query-section ${className}`}
          >
            {results}
          </NodeViewSection>
        );
      }}
    </QueryNodeCollection>
  );
}

export default QuerySection;
