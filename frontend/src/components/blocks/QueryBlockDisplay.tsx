/**
 * QueryBlockDisplay Component
 * 
 * Provides inline query controls and results for blocks classed as "query".
 * Returns an object with:
 * - controls: Query action buttons to display inline with block content (right side)
 * - results: Query results to display below the block
 */
import { DynamicNodeViewSection } from '../nodes/DynamicNodeViewSection';
import type { Node } from '@/types/api';
import { useSystemClasses } from '@/hooks/useNodes';
import './QueryBlockDisplay.css';

export interface QueryBlockDisplayProps {
  block: Node;
  onNodeClick?: (nodeId: number, isPage?: boolean) => void;
}

export interface QueryBlockDisplayResult {
  controls: React.ReactNode;
  results: React.ReactNode;
}

export function QueryBlockDisplay({ block, onNodeClick }: QueryBlockDisplayProps): QueryBlockDisplayResult | null {
  const { systemClassIds } = useSystemClasses();
  
  console.log('[QueryBlockDisplay] Block', block.id, 'classes:', block.classes, 'systemClassIds:', systemClassIds);
  
  // Check if block has the query class
  const isQueryBlock = systemClassIds?.query 
    ? block.classes?.includes(systemClassIds.query)
    : false;

  console.log('[QueryBlockDisplay] Block', block.id, 'isQueryBlock:', isQueryBlock);

  if (!isQueryBlock) {
    return null;
  }

  // Use DynamicNodeViewSection in split mode
  // It will return controls and content separately
  const result = DynamicNodeViewSection({
    nodeId: block.id,
    nodeUuid: block.uuid,
    viewType: "main_content",
    title: "",
    hideWhenEmpty: false,
    defaultExpanded: true,
    onNodeClick,
    split: true,
  });
  
  console.log('[QueryBlockDisplay] DynamicNodeViewSection result:', result);
  
  // Type guard: ensure we got the split result
  if (!result || typeof result !== 'object' || !('controls' in result)) {
    return null;
  }
  
  return result as QueryBlockDisplayResult;
}

export default QueryBlockDisplay;
