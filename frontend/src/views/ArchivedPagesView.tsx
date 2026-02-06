/**
 * Archived Pages View
 * 
 * Displays pages that have been archived (active = false).
 * Fetches directly from the /archived endpoint instead of using query system.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { NodeCollection } from '../components/nodes/NodeCollection';
import { NodeCollectionToolbar } from '../components/nodes/NodeCollectionToolbar';
import { ArchivedNodeContextMenu } from '../components/nodes/ArchivedNodeContextMenu';
import { useNodesStore } from '@/stores';
import api from '@/api/client';
import { unarchiveNode, deleteNode } from '@/api/nodes';
import type { Node } from '@/types/api';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import type { ContextMenuItem } from '@/components/core/ContextMenu';
import { useState, useCallback } from 'react';
import './ArchivedPagesView.css';

interface ArchivedPagesViewProps {
  className?: string;
}

export function ArchivedPagesView({ className = '' }: ArchivedPagesViewProps) {
  const { openNode } = useNodesStore();
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('list');
  const queryClient = useQueryClient();
  
  // Mutation for unarchiving nodes
  const unarchiveMutation = useMutation({
    mutationFn: unarchiveNode,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['archived-pages'] });
    },
  });
  
  // Mutation for deleting nodes
  const deleteMutation = useMutation({
    mutationFn: deleteNode,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['archived-pages'] });
    },
  });
  
  // Generate context menu items for archived nodes
  const generateContextMenuItems = useCallback((node: Node, closeMenu: () => void): ContextMenuItem[] => {
    return [
      {
        id: 'unarchive',
        label: 'Unarchive',
        icon: 'mdi mdi-archive-arrow-up',
        onClick: () => {
          if (confirm('Unarchive this page?')) {
            unarchiveMutation.mutate(node.id);
          }
          closeMenu();
        },
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: 'mdi mdi-delete',
        onClick: () => {
          if (confirm('Delete this page permanently? This action cannot be undone.')) {
            deleteMutation.mutate(node.id);
          }
          closeMenu();
        },
        danger: true,
      },
    ];
  }, [unarchiveMutation, deleteMutation]);
  
  // Fetch archived pages directly from API
  const { data: nodes, isLoading, error } = useQuery({
    queryKey: ['archived-pages'],
    queryFn: async () => {
      const response = await api.get<{ pages: Node[] }>('/nodes/archived');
      return response.data.pages;
    },
  });
  
  return (
    <article className={`node-view node-view--page archived-pages-view ${className}`}>
      {/* Page Header */}
      <div className="page-header-section">
        <div className="page-header-section__header">
          <div className="page-header">
            <h1 className="page-header__title">
              <i className="mdi mdi-archive"></i> Archived Pages
            </h1>
          </div>
        </div>
      </div>
      
      {/* Archived Collection */}
      <div className="archived-pages-view__content">
        <div className="archived-pages-view__toolbar">
          <NodeCollectionToolbar
            viewMode={viewMode}
            availableViewModes={['list', 'table', 'card']}
            onViewModeChange={setViewMode}
            groupBy="none"
            onGroupByChange={() => {}}
          />
        </div>
        
        {isLoading && <div className="archived-pages-view__loading">Loading...</div>}
        {error && <div className="archived-pages-view__error">Failed to load archived pages</div>}
        {!isLoading && !error && (
          <NodeCollection
            nodes={nodes ?? []}
            viewMode={viewMode}
            editable={false}
            showClasses={true}
            hideToolbar={true}
            customContextMenu={ArchivedNodeContextMenu}
            customContextMenuItems={generateContextMenuItems}
            onNodeClick={(node) => openNode(node.id, 'page')}
          />
        )}
      </div>
    </article>
  );
}

export default ArchivedPagesView;
