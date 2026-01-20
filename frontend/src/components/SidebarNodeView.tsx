/**
 * SidebarNodeView Component
 * 
 * A minified version of NodeView for displaying nodes in the sidebar.
 * - Pages: Shows a card header with page name, icon, and expand button,
 *   followed by NodeContent and linked references
 * - Blocks: Shows the block itself as an editable block (like focused block mode),
 *   followed by its children and linked references
 */
import { useMemo, useCallback } from 'react';
import { useNode, useUpdateNode, useAddTag, useAddType, useAddTagLink, useCreatePage, useTypes } from '@/hooks';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { useNodesStore } from '@/stores';
import type { NodeUpdate } from '@/types';
import type { SidebarNodeType } from '@/stores';
import { BlockEditor } from './BlockEditor';
import { Block } from './Block';
import { LinkedReferences } from './Backlinks';
import { NodeIcon } from './icons';
import './SidebarNodeView.css';

interface SidebarNodeViewProps {
  nodeId: number;
  nodeType: SidebarNodeType;
}

export function SidebarNodeView({ nodeId, nodeType }: SidebarNodeViewProps) {
  const { data: node, isLoading, error } = useNode(nodeId, { 
    include_children: true,
    include_backlinks: true 
  });
  
  const updateNode = useUpdateNode();
  const createPage = useCreatePage();
  const addTag = useAddTag();
  const addType = useAddType();
  const addTagLink = useAddTagLink();
  const { data: allTypes } = useTypes();
  const { openNode, closeSidebarNode, addSidebarCard, openCommentsForNode } = useNodesStore();

  // Handlers
  const handleNameChange = useCallback((newName: string) => {
    if (!node) return;
    const data: NodeUpdate = { name: newName };
    updateNode.mutate({ id: node.id, data });
  }, [node, updateNode]);

  const handleBlockChange = useCallback((blockId: number, name: string) => {
    const data: NodeUpdate = { name };
    updateNode.mutate({ id: blockId, data });
  }, [updateNode]);

  const handleOpenFull = useCallback(() => {
    if (!node) return;
    openNode(node.id, nodeType);
    closeSidebarNode();
  }, [node, nodeType, openNode, closeSidebarNode]);

  const handleBlockBulletClick = useCallback((blockId: number) => {
    openNode(blockId, 'block');
    closeSidebarNode();
  }, [openNode, closeSidebarNode]);

  const handleBlockShiftClick = useCallback((blockId: number) => {
    addSidebarCard(blockId, 'block');
  }, [addSidebarCard]);

  const handleLinkClick = useCallback((targetId: number, pageId?: number | null, isPage?: boolean) => {
    if (pageId) {
      openNode(pageId, 'page');
    } else {
      openNode(targetId, isPage ? 'page' : 'block');
    }
    closeSidebarNode();
  }, [openNode, closeSidebarNode]);

  // Handle adding a type to a block
  const handleAddType = useCallback((blockId: number) => (typeNodeId: number, _keepInline: boolean, _typeName: string) => {
    addType.mutate({ nodeId: blockId, typeId: typeNodeId });
  }, [addType]);

  // Handle adding a tag to a block
  const handleAddTag = useCallback((blockId: number) => (tagNodeId: number, keepInline: boolean, _tagName: string) => {
    addTag.mutate({ nodeId: blockId, tagId: tagNodeId });
    if (keepInline) {
      addTagLink.mutate({ nodeId: blockId, targetNodeId: tagNodeId });
    }
  }, [addTag, addTagLink]);

  // Handle creating a new type
  const handleCreateType = useCallback((blockId: number) => (name: string) => {
    const typeType = allTypes?.find(t => t.name?.toLowerCase() === 'type');
    createPage.mutate({ name }, {
      onSuccess: (newPage) => {
        addType.mutate({ nodeId: blockId, typeId: newPage.id });
        if (typeType) {
          addType.mutate({ nodeId: newPage.id, typeId: typeType.id });
        }
      }
    });
  }, [createPage, addType, allTypes]);

  // Handle creating a new tag
  const handleCreateTag = useCallback((blockId: number) => (name: string) => {
    createPage.mutate({ name }, {
      onSuccess: (newPage) => {
        addTag.mutate({ nodeId: blockId, tagId: newPage.id });
      }
    });
  }, [createPage, addTag]);

  // Handle opening comments
  const handleOpenComments = useCallback((blockId: number) => () => {
    openCommentsForNode(blockId);
  }, [openCommentsForNode]);

  // Filter children (blocks only, no pages) - must be before early returns
  const blockChildren = useMemo(() => {
    if (!node?.children) return [];
    return node.children.filter(child => !child.is_page);
  }, [node?.children]);

  // Get effective icon (node's icon or first type's icon)
  const effectiveIcon = useMemo(() => getEffectiveIcon(node, allTypes), [node, allTypes]);

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
      {/* Header - different for pages vs blocks */}
      {nodeType === 'page' ? (
        /* Page Header - card style with name and expand */
        <header className="sidebar-node-view__header sidebar-node-view__header--page">
          <div className="sidebar-node-view__title">
            {effectiveIcon || node.is_daily || node.is_monthly || node.is_yearly ? (
              <NodeIcon icon={effectiveIcon} isPage={true} isDaily={node.is_daily} isMonthly={node.is_monthly} isYearly={node.is_yearly} size="sm" className="sidebar-node-view__icon" />
            ) : (
              <NodeIcon isPage={true} size="sm" className="sidebar-node-view__icon" />
            )}
            <input
              type="text"
              className="sidebar-node-view__title-input"
              value={node.name || ''}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="Untitled"
            />
          </div>
          <button 
            className="sidebar-node-view__expand-btn"
            onClick={handleOpenFull}
            title="Open in main view"
          >
            ↗
          </button>
        </header>
      ) : (
        /* Block Header - editable block style */
        <header className="sidebar-node-view__header sidebar-node-view__header--block">
          <div className="sidebar-node-view__block-header-content">
            <span className="sidebar-node-view__bullet">•</span>
            <span className="sidebar-node-view__label">Block</span>
          </div>
          <button 
            className="sidebar-node-view__expand-btn"
            onClick={handleOpenFull}
            title="Open in focused view"
          >
            ↗
          </button>
        </header>
      )}

      {/* Content */}
      <div className="sidebar-node-view__content">
        {nodeType === 'block' && (
          /* For blocks, show the block itself as editable */
          <div className="sidebar-node-view__block-editor">
            <BlockEditor
              nodeId={node.id}
              content={node.name || ''}
              onChange={handleNameChange}
              onAddType={handleAddType(node.id)}
              onAddTag={handleAddTag(node.id)}
              onCreateType={handleCreateType(node.id)}
              onCreateTag={handleCreateTag(node.id)}
              onOpenComments={handleOpenComments(node.id)}
              readOnly={false}
            />
          </div>
        )}

        {/* Children blocks */}
        {blockChildren.length > 0 && (
          <div className="sidebar-node-view__children">
            {nodeType === 'block' && (
              <div className="sidebar-node-view__children-label">Children</div>
            )}
            {blockChildren.slice(0, 5).map((child) => (
              <div key={child.id} className="sidebar-node-view__child">
                <Block
                  block={child}
                  children={child.children}
                  parentId={node.id}
                  onContentChange={handleBlockChange}
                  onBulletClick={handleBlockBulletClick}
                  onShiftClick={handleBlockShiftClick} 
                  onAddType={handleAddType(child.id)}
                  onAddTag={handleAddTag(child.id)}
                  onCreateType={handleCreateType(child.id)}
                  onCreateTag={handleCreateTag(child.id)}
                  onOpenComments={handleOpenComments(child.id)}
                  commentCount={child.comment_count}
                  backlinkCount={child.backlink_count}
                  onOpenBacklinks={() => handleBlockShiftClick(child.id)}
                />
              </div>
            ))}
            {blockChildren.length > 5 && (
              <div className="sidebar-node-view__more">
                +{blockChildren.length - 5} more blocks
              </div>
            )}
          </div>
        )}

        {blockChildren.length === 0 && nodeType === 'page' && (
          <div className="sidebar-node-view__empty">
            No content
          </div>
        )}
      </div>

      {/* Linked References */}
      <div className="sidebar-node-view__references">
        <LinkedReferences
          nodeId={node.id}
          onLinkClick={handleLinkClick}
          className="sidebar-node-view__linked-refs"
        />
      </div>

      {/* Footer */}
      <footer className="sidebar-node-view__footer">
        <span className="sidebar-node-view__meta">
          {new Date(node.write_date).toLocaleDateString()}
        </span>
        {nodeType === 'block' && node.page_id && (
          <button 
            className="sidebar-node-view__page-link"
            onClick={() => { openNode(node.page_id!, 'page'); closeSidebarNode(); }}
          >
            View page
          </button>
        )}
      </footer>
    </div>
  );
}

export default SidebarNodeView;
