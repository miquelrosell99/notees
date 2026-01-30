/**
 * QueryBlockDisplay Component
 * 
 * Renders query views with tabs for blocks that are classed as "query".
 * Displays the DynamicNodeViewSection which handles view tabs and editing.
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

  console.log('[QueryBlockDisplay]', {
    blockId: block.id,
    blockName: block.name,
    classes: block.classes,
    systemQueryClassId: systemClassIds?.query,
    isQueryBlock
  });

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
      />
    </div>
  );
}

export default QueryBlockDisplay;
