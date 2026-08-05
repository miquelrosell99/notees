/**
 * SidebarNodeView Component
 * 
 * Wraps NodeViewContent to display nodes in the sidebar.
 * Uses the same NodeView component as the main view, just in a compact container.
 * - Pages: Uses NodeViewContent with sidebarMode for a condensed page view
 * - Blocks: Uses NodeViewContent for focused block view
 */
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useNode } from '@/features/content';
import { nodeNameToDisplayText } from '@/features/queries';
import { useNavigationStore } from '@/stores';
import { Spinner } from '@/components/ui/Spinner';
import type { SidebarNodeType } from '@/stores';
import { NodeViewContent } from '@/features/content';
import { NodeIcon, BulletIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import './SidebarNodeView.css';

interface SidebarNodeViewProps {
  nodeUuid: string;
  nodeType: SidebarNodeType;
}

export function SidebarNodeView({ nodeUuid, nodeType }: SidebarNodeViewProps) {
  const { data: node, isLoading, error } = useNode(nodeUuid);
  const { openNode, viewMode } = useNavigationStore(
    useShallow((state) => ({ openNode: state.openNode, viewMode: state.viewMode })),
  );

  const handleOpenFull = useCallback(() => {
    if (!node) return;
    openNode(node.uuid);
  }, [node, openNode]);

  // Loading state
  if (isLoading) {
    return (
      <div className="sidebar-node-view sidebar-node-view--loading">
        <Spinner size="md" centered />
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
      <header className="sidebar-node-view__header">
        <div className="sidebar-node-view__title">
          {nodeType === 'page' ? (
            <>
              <NodeIcon icon={node.icon} isPage={true} size="sm" className="sidebar-node-view__icon" />
              <span className="sidebar-node-view__name">{nodeNameToDisplayText(node) || 'Untitled'}</span>
            </>
          ) : (
            <>
              <BulletIcon size="xs" className="sidebar-node-view__bullet" />
              <span className="sidebar-node-view__name">{nodeNameToDisplayText(node) || 'Untitled'}</span>
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

      {/* Content - just NodeViewContent */}
      <div className="sidebar-node-view__content">
        <NodeViewContent
          nodeUuid={node?.uuid ?? ''}
          viewMode={viewMode}
          sidebarMode={true}
        />
      </div>
    </div>
  );
}

