/**
 * ChildPagesSection - Displays child pages of a parent page
 * 
 * Uses NodeCollection to display pages. NodeViewSection wrapping is handled by NodeView.
 * Supports list, table, and card view modes.
 * 
 * The toolbar can be rendered externally via ChildPagesSectionToolbar component
 * for placement in NodeViewSection headers.
 */
import { useCallback, useState } from 'react';
import { NodeCollection, NodeCollectionToolbar } from './nodes/NodeCollection';
import { useNodesStore } from '@/stores';
import { useBlockSelectionStore } from '@/stores/blockSelectionStore';
import { useCreateNode } from '@/hooks';
import type { Node } from '@/types';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';

/**
 * State and callbacks for ChildPagesSection toolbar
 * Extracted so toolbar can be rendered in NodeViewSection header
 */
export interface ChildPagesSectionToolbarState {
  viewMode: NodeCollectionViewMode;
  setViewMode: (mode: NodeCollectionViewMode) => void;
  onAdd: () => void;
  hasItems: boolean;
}

/**
 * Hook to manage ChildPagesSection view state
 * Use this when you need to render the toolbar externally
 */
export function useChildPagesSectionState(pageId: number, childPages?: Node[]): ChildPagesSectionToolbarState {
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('list');
  const { openNode } = useNodesStore();
  const { setBlockState, setPendingCaret } = useBlockSelectionStore();
  const createNode = useCreateNode();
  
  const onAdd = useCallback(() => {
    // Compute next sequence from existing child pages
    const maxSequence = childPages?.reduce((max, child) => 
      Math.max(max, child.sequence ?? 0), -1) ?? -1;
    
    createNode.mutate({ name: '', is_page: true, parent_id: pageId, sequence: maxSequence + 1 }, {
      onSuccess: (newPage) => {
        if (viewMode === 'list') {
          // List view: open the node in main view
          openNode(newPage.id, 'page');
        } else if (viewMode === 'table' || viewMode === 'card') {
          // Table/Card view: set to edit mode and scroll to it
          setTimeout(() => {
            // Find the newly created element
            const newElement = document.querySelector(`[data-block-id="${newPage.id}"]`);
            if (newElement) {
              // Scroll smoothly to the new element
              newElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            
            // Set block to edit mode with cursor at start
            setBlockState(newPage.id, 'edit');
            setPendingCaret(newPage.id, 0);
          }, 100); // Small delay to ensure DOM update
        }
      }
    });
  }, [createNode, pageId, childPages, openNode, viewMode, setBlockState, setPendingCaret]);
  
  return {
    viewMode,
    setViewMode,
    onAdd,
    hasItems: (childPages?.length ?? 0) > 0,
  };
}

/**
 * Standalone toolbar for ChildPagesSection
 * Render this in NodeViewSection headerActions when using hideToolbar=true
 */
export function ChildPagesSectionToolbar({
  state,
  className = '',
}: {
  state: ChildPagesSectionToolbarState;
  className?: string;
}) {
  return (
    <NodeCollectionToolbar
      viewMode={state.viewMode}
      availableViewModes={['list', 'table', 'card']}
      onViewModeChange={state.setViewMode}
      showAddButton={true}
      onAdd={state.onAdd}
      className={className}
    />
  );
}

interface ChildPagesSectionProps {
  pageId: number;
  /** Child pages to display */
  childPages?: Node[];
  /** Default view mode */
  defaultViewMode?: NodeCollectionViewMode;
  /** When true, hides the internal toolbar (use ChildPagesSectionToolbar externally) */
  hideToolbar?: boolean;
  /** External state for toolbar control (required when hideToolbar=true) */
  toolbarState?: ChildPagesSectionToolbarState;
}

export function ChildPagesSection({ 
  pageId,
  childPages,
  defaultViewMode = 'list',
  hideToolbar = false,
  toolbarState,
}: ChildPagesSectionProps) {
  const { openNode, addSidebarCard } = useNodesStore();
  const createNode = useCreateNode();
  
  // Internal state when not using external toolbar
  const [internalViewMode, setInternalViewMode] = useState<NodeCollectionViewMode>(defaultViewMode);
  
  // Use external state if provided, otherwise use internal
  const viewMode = toolbarState?.viewMode ?? internalViewMode;
  const setViewMode = toolbarState?.setViewMode ?? setInternalViewMode;
  
  const count = childPages?.length ?? 0;
  
  const handleNodeClick = useCallback((node: Node) => {
    openNode(node.id, 'page');
  }, [openNode]);
  
  const handleNodeShiftClick = useCallback((node: Node) => {
    addSidebarCard(node.id, 'page');
  }, [addSidebarCard]);
  
  const handleAddChildPage = useCallback(() => {
    // Compute next sequence from existing child pages
    const maxSequence = childPages?.reduce((max, child) => 
      Math.max(max, child.sequence ?? 0), -1) ?? -1;
    
    createNode.mutate({ name: '', is_page: true, parent_id: pageId, sequence: maxSequence + 1 }, {
      onSuccess: (newPage) => {
        openNode(newPage.id, 'page');
      }
    });
  }, [createNode, pageId, childPages, openNode]);
  
  // Don't render if no child pages
  if (count === 0) {
    return null;
  }

  return (
    <NodeCollection
      nodes={childPages ?? []}
      viewMode={viewMode}
      onViewModeChange={setViewMode}
      availableViewModes={['list', 'table', 'card']}
      sortable={false}
      pagesOnly={true}
      showTypes={true}
      onNodeClick={handleNodeClick}
      onNodeShiftClick={handleNodeShiftClick}
      showAddButton={!hideToolbar}
      onAdd={handleAddChildPage}
      hideToolbar={hideToolbar}
    />
  );
}

export default ChildPagesSection;
