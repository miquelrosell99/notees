/**
 * InlineNodeLink Component
 * 
 * Custom element for inline node references in contenteditable.
 * Renders as: [[Block content preview]]
 * 
 * Features:
 * - Atomic element (non-editable, cursor cannot enter)
 * - Clickable to navigate to linked node
 * - Shows accent border when selected
 * - Displays linked node content in readonly mode without bullet
 */
import { useCallback, useMemo } from 'react';
import { useNode } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useNodesStore } from '@/stores';
import './InlineNodeLink.css';

interface InlineNodeLinkProps {
  /** UUID of the linked node */
  uuid: string;
  /** Node ID for faster lookup (optional) */
  nodeId?: number;
  /** Whether this link is selected (cursor on it) */
  selected?: boolean;
  /** Click handler */
  onClick?: (e: React.MouseEvent) => void;
  /** Shift+Click handler */
  onShiftClick?: (e: React.MouseEvent) => void;
}

export function InlineNodeLink({
  uuid,
  nodeId,
  selected = false,
  onClick,
  onShiftClick,
}: InlineNodeLinkProps) {
  const { openNode, addSidebarCard } = useNodesStore();
  
  // Fetch the linked node
  const { data: linkedNode } = useNode(nodeId ?? null);
  
  // Display text - show node name or fallback
  const displayText = useMemo(() => {
    if (!linkedNode) {
      return `[Missing: ${uuid.substring(0, 8)}...]`;
    }
    
    const name = nodeNameToText(linkedNode?.name) || 'Untitled';
    
    if (!name || name === 'Untitled') {
      if (linkedNode.is_page) {
        return '[Untitled Page]';
      } else {
        return '[Empty Block]';
      }
    }
    
    // For blocks, truncate long content
    if (!linkedNode.is_page && name.length > 60) {
      return `${name.slice(0, 60)}...`;
    }
    
    return name;
  }, [linkedNode, uuid]);
  
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (onClick) {
      onClick(e);
      return;
    }
    
    if (!linkedNode) return;
    
    const viewType = linkedNode.is_page ? 'page' : 'block';
    
    if (e.shiftKey && onShiftClick) {
      onShiftClick(e);
    } else if (e.shiftKey) {
      addSidebarCard(linkedNode.id, viewType);
    } else {
      openNode(linkedNode.id, viewType);
    }
  }, [linkedNode, onClick, onShiftClick, openNode, addSidebarCard]);
  
  return (
    <span
      className={`inline-node-link ${selected ? 'inline-node-link--selected' : ''}`}
      contentEditable={false}
      data-node-uuid={uuid}
      data-node-id={nodeId}
      onClick={handleClick}
      onMouseDown={(e) => e.preventDefault()} // Prevent text selection
      title={`Click to open, Shift+click for sidebar`}
    >
      <span className="inline-node-link__bracket">[[</span>
      <span className="inline-node-link__content">{displayText}</span>
      <span className="inline-node-link__bracket">]]</span>
    </span>
  );
}
