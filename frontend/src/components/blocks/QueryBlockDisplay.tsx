/**
 * QueryBlockDisplay Component
 * 
 * Provides inline query controls and results for blocks classed as "query".
 * Can be used in two ways:
 * 1. With children render prop: passes { controls, results } to children function
 * 2. Without children: returns { controls, results } as before (for backwards compat)
 */
import { DynamicNodeViewSection } from '../nodes/DynamicNodeViewSection';
import type { Node } from '@/types/api';
import { useSystemClasses } from '@/hooks/useNodes';
import './QueryBlockDisplay.css';

export interface QueryBlockDisplayProps {
  block: Node;
  onNodeClick?: (nodeId: number, isPage?: boolean) => void;
  children?: (result: QueryBlockDisplayResult | null) => React.ReactNode;
}

export interface QueryBlockDisplayResult {
  controls: React.ReactNode;
  results: React.ReactNode;
}

export function QueryBlockDisplay({ block, onNodeClick, children }: QueryBlockDisplayProps): QueryBlockDisplayResult | React.ReactNode | null {
  const { systemClassIds } = useSystemClasses();
  
  // Check if block has the query class
  const isQueryBlock = systemClassIds?.query 
    ? block.classes?.includes(systemClassIds.query)
    : false;

  if (!isQueryBlock) {
    return children ? children(null) : null;
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
  
  // Type guard: ensure we got the split result
  if (!result || typeof result !== 'object' || !('controls' in result)) {
    return children ? children(null) : null;
  }
  
  const queryResult = result as QueryBlockDisplayResult;
  
  // If children render prop provided, call it with the result
  if (children) {
    return children(queryResult);
  }
  
  // Otherwise return the result object (backwards compat)
  return queryResult;
}

export default QueryBlockDisplay;
