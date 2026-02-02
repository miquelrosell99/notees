/**
 * QueryBlockDisplay Component
 * 
 * Renders query views with tabs for blocks that are classed as "query".
 * Displays the DynamicNodeViewSection in headless mode (no section header)
 * so the block's own content acts as the header, with query controls and
 * results appearing inline below.
 */
import { DynamicNodeViewSection } from '../nodes/DynamicNodeViewSection';
import type { Node } from '@/types/api';
import { useSystemClasses } from '@/hooks/useNodes';
import './QueryBlockDisplay.css';

export interface QueryBlockDisplayProps {
  block: Node;
  onNodeClick?: (nodeId: number, isPage?: boolean) => void;
}

export function QueryBlockDisplay({ block, onNodeClick }: QueryBlockDisplayProps) {
  const { systemClassIds } = useSystemClasses();
  
  // Check if block has the query class
  const isQueryBlock = systemClassIds?.query 
    ? block.classes?.includes(systemClassIds.query)
    : false;

  if (!isQueryBlock) {
    return null;
  }

  return (
    <div className="query-block-display">
      <DynamicNodeViewSection
        nodeId={block.id}
        nodeUuid={block.uuid}
        viewType="main_content"
        title=""
        hideWhenEmpty={false}
        defaultExpanded={true}
        onNodeClick={onNodeClick}
        headless={true}
      />
    </div>
  );
}

export default QueryBlockDisplay;
