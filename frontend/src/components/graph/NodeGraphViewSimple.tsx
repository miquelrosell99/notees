/**
 * NodeGraphViewSimple Component
 * 
 * Simplified graph view without UI chrome:
 * - No settings panel
 * - No type colors panel
 * - No view mode switcher
 * - No search panel
 * - Just the graph with basic interactions
 * 
 * Used for minimap cards and local graph displays.
 */
import { useRef, useMemo, useCallback } from 'react';
import { useNodesStore } from '@/stores';
import type { GraphNode as ApiGraphNode } from '@/api/nodes';
import { 
  NodeGraphRenderer, 
  type NodeGraphRendererRef,
  type GraphNode,
  type GraphLink,
} from './NodeGraphRenderer';
import './NodeGraphViewSimple.css';

export interface NodeGraphViewSimpleProps {
  /** Graph data - nodes from API */
  nodes: ApiGraphNode[];
  /** Graph links from API */
  links: Array<{ source: number; target: number; type: 'parent' | 'reference' }>;
  /** Currently highlighted node ID (e.g., current page) */
  currentNodeId?: number | null;
  /** CSS class */
  className?: string;
  /** Node click handler override */
  onNodeClick?: (nodeId: number) => void;
}

export function NodeGraphViewSimple({
  nodes: inputNodes,
  links: inputLinks,
  currentNodeId = null,
  className = '',
  onNodeClick: customNodeClick,
}: NodeGraphViewSimpleProps) {
  const rendererRef = useRef<NodeGraphRendererRef>(null);
  const { openNode, addSidebarCard } = useNodesStore();
  
  // Convert API data to renderer format
  const { nodes, links } = useMemo(() => {
    const parentMap = new Map<number, number>();
    for (const link of inputLinks) {
      if (link.type === 'parent') {
        parentMap.set(link.target, link.source);
      }
    }
    
    const nodes: GraphNode[] = inputNodes.map((apiNode) => ({
      id: apiNode.id,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      targetX: 0,
      targetY: 0,
      name: apiNode.name || 'Untitled',
      type: apiNode.type || 'page',
      isDaily: apiNode.is_daily || false,
      tags: apiNode.tags || [],
      types: apiNode.type_ids || apiNode.types || [],
      parentId: parentMap.get(apiNode.id) ?? null,
      glare: 'normal',
      pinned: false,
      color: (apiNode.properties?.color as string) || undefined,
      backlinkCount: apiNode.backlink_count ?? 0,
      internalLinkCount: apiNode.internal_link_count ?? 0,
      createdAt: apiNode.created_at,
      visible: true,
      isTypeNode: apiNode.is_type || false,
    }));
    
    const links: GraphLink[] = inputLinks.map(link => ({
      source: link.source,
      target: link.target,
      type: link.type,
    }));
    
    return { nodes, links };
  }, [inputNodes, inputLinks]);
  
  // Event handlers - simplified for minimap behavior
  const handleNodeClick = useCallback((node: GraphNode, event: { shiftKey: boolean }) => {
    if (customNodeClick) {
      customNodeClick(node.id);
    } else if (event.shiftKey) {
      addSidebarCard(node.id, node.type);
    } else {
      openNode(node.id, node.parentId === null ? 'page' : 'block');
    }
  }, [customNodeClick, openNode, addSidebarCard]);
  
  const handleNodeDoubleClick = useCallback((node: GraphNode) => {
    openNode(node.id, node.parentId === null ? 'page' : 'block');
  }, [openNode]);
  
  if (nodes.length === 0) {
    return (
      <div className={`node-graph-view-simple empty ${className}`}>
        <div className="node-graph-view-simple__empty">No connections</div>
      </div>
    );
  }
  
  return (
    <div className={`node-graph-view-simple ${className}`}>
      <NodeGraphRenderer
        ref={rendererRef}
        nodes={nodes}
        links={links}
        viewMode="normal"
        currentNodeId={currentNodeId}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        className="node-graph-view-simple__renderer"
      />
    </div>
  );
}

export default NodeGraphViewSimple;
