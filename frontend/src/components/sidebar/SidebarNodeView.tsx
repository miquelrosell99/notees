/**
 * SidebarNodeView Component
 * 
 * Wraps NodeViewContent to display nodes in the sidebar.
 * Uses the same NodeView component as the main view, just in a compact container.
 * - Pages: Uses NodeViewContent with sidebarMode for a condensed page view
 * - Blocks: Uses NodeViewContent for focused block view
 */
import { useCallback } from 'react';
import { useNode } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useNavigationStore } from '@/stores';
import type { SidebarNodeType } from '@/stores';
import { NodeViewContent } from '@/views/NodeView';
import { NodeIcon } from '@/components/core/icons';
import { Button } from '@/components/core/Button';
import './SidebarNodeView.css';

interface SidebarNodeViewProps {
  nodeId: number;
  nodeType: SidebarNodeType;
  /** Whether to hide the internal header (when wrapped in SidebarCard) */
  hideHeader?: boolean;
}

export function SidebarNodeView({ nodeId, nodeType, hideHeader = false }: SidebarNodeViewProps) {
  const { data: node, isLoading, error } = useNode(nodeId);
  const { openNode, closeSidebarNode, viewMode } = useNavigationStore();

  const handleOpenFull = useCallback(() => {
    if (!node) return;
    openNode(node.id);
    closeSidebarNode();
  }, [node, openNode, closeSidebarNode]);

  // Loading state
  if (isLoading) {
    return (
      <div className="sidebar-node-view sidebar-node-view--loading">
        <div className="sidebar-node-view__loading">Loading...</div>
      </div>
    );
  }

  // Error state
  if (error || !node) {
    return (
      <div className="sidebar-node-view sidebar-node-view--error">
        <div className="sidebar-node-view__error">Node not found</div>
      </div>
    );
  }

  return (
    <div className={`sidebar-node-view sidebar-node-view--${nodeType}`}>
      {/* Header with expand button */}
      {!hideHeader && (
        <header className="sidebar-node-view__header">
          <div className="sidebar-node-view__title">
            {nodeType === 'page' ? (
              <>
                <NodeIcon icon={node.icon} isPage={true} size="sm" className="sidebar-node-view__icon" />
                <span className="sidebar-node-view__name">{nodeNameToText(node.name) || 'Untitled'}</span>
              </>
            ) : (
              <>
                <span className="sidebar-node-view__bullet">•</span>
                <span className="sidebar-node-view__label">Block</span>
              </>
            )}
          </div>
          <Button 
            className="sidebar-node-view__expand-btn"
            variant="ghost"
            size="sm"
            onClick={handleOpenFull}
            title={nodeType === 'page' ? 'Open in main view' : 'Open in focused view'}
          >
            ↗
          </Button>
        </header>
      )}

      {/* Content - just NodeViewContent */}
      <div className="sidebar-node-view__content">
        <NodeViewContent
          nodeId={nodeId}
          viewMode={viewMode}
          sidebarMode={true}
        />
      </div>
    </div>
  );
}

