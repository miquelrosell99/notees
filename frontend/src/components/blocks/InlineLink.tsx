/**
 * InlineLink Component
 * 
 * HTML anchor-style link for inline node references in contenteditable.
 * Renders as a styled anchor tag without brackets.
 * 
 * Features:
 * - Atomic element (non-editable, cursor cannot enter)
 * - Clickable to navigate to linked node
 * - Shows accent underline when hovered
 * - Displays custom or node name
 */
import { useCallback } from 'react';
import { useNode } from '@/hooks';
import { useNodesStore } from '@/stores';
import './InlineLink.css';

interface InlineLinkProps {
  /** Link UUID for tracking */
  uuid?: string;
  /** Target node ID */
  nodeId: number | null;
  /** Custom display text (overrides node name) */
  customName?: string | null;
  /** Whether the link is selected */
  selected?: boolean;
  /** Custom click handler */
  onClick?: (e: React.MouseEvent) => void;
  /** Custom shift+click handler */
  onShiftClick?: (e: React.MouseEvent) => void;
}

export function InlineLink({
  uuid,
  nodeId,
  customName,
  selected = false,
  onClick,
  onShiftClick,
}: InlineLinkProps) {
  const { openNode, addSidebarCard } = useNodesStore();
  
  // Fetch the linked node
  const { data: linkedNode } = useNode(nodeId ?? null);
  
  // Display text - use custom name if available, otherwise node name
  const displayText = customName || linkedNode?.name || (nodeId ? `Node ${nodeId}` : 'Unknown');
  
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
    <a
      className={`inline-link ${selected ? 'inline-link--selected' : ''}`}
      onClick={handleClick}
      onMouseDown={(e) => e.preventDefault()} // Prevent text selection on click
    >
      {displayText}
    </a>
  );
}
