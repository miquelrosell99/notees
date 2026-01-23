/**
 * SidebarNodeView Component
 * 
 * A minified version of NodeView for displaying nodes in the sidebar.
 * - Pages: Shows types, tags, properties (collapsed), children blocks (list view),
 *   and additional sections (typed nodes, children pages, linked refs) collapsed
 * - Blocks: Shows the block itself as an editable block (like focused block mode),
 *   followed by its children and linked references
 */
import { useMemo, useCallback } from 'react';
import { 
  useNode, 
  useUpdateNode, 
  useAddTag, 
  useAddType, 
  useAddTagLink, 
  useCreateNode, 
  useTypes,
  useTags,
  useNodes,
  useRemoveType,
  useRemoveTag,
  useNodesWithType,
} from '@/hooks';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { useNodesStore, useSettingsStore } from '@/stores';
import type { NodeUpdate, Node } from '@/types';
import type { SidebarNodeType } from '@/stores';
import type { BlockCallbacks } from './blocks/BlockCallbacksContext';
import { BlockEditor } from './blocks/BlockEditor';
import { Block } from './blocks/Block';
import { NodeCollection } from './nodes/NodeCollection';
import { LinkedReferences, useLinkedReferencesCount, useLinkedReferencesState, LinkedReferencesToolbar } from './LinkedReferences';
import { TypedNodesView, useTypedNodesSectionState, TypedNodesSectionToolbar } from './TypedNodesSection';
import { ChildPagesSection, useChildPagesSectionState, ChildPagesSectionToolbar } from './ChildPagesSection';
import { PropertiesSection } from './PropertiesSection';
import { NodePillRow } from './NodePillRow';
import { NodeViewSection, DynamicNodeViewSection } from './nodes';
import { NodeIcon, TableIcon, PageIcon, LinkIcon } from './icons';
import { Button } from './core/Button';
import { SYSTEM_TYPE_UUIDS, isSystemTypeUuid } from '@/constants';
import './SidebarNodeView.css';

interface SidebarNodeViewProps {
  nodeId: number;
  nodeType: SidebarNodeType;
  /** Whether to hide the internal header (when wrapped in SidebarCard) */
  hideHeader?: boolean;
}

export function SidebarNodeView({ nodeId, nodeType, hideHeader = false }: SidebarNodeViewProps) {
  const { data: node, isLoading, error } = useNode(nodeId, { 
    include_children: true,
    include_backlinks: true,
    include_properties: true,
  });
  
  // Settings
  const useDynamicNodeViews = useSettingsStore(state => state.useDynamicNodeViews);
  
  const updateNode = useUpdateNode();
  const createNode = useCreateNode();
  const addTag = useAddTag();
  const addType = useAddType();
  const addTagLink = useAddTagLink();
  const removeType = useRemoveType();
  const removeTag = useRemoveTag();
  const { data: allTypes } = useTypes();
  const { data: allTags } = useTags();
  const { data: allNodes } = useNodes({ pages_only: true });
  const { openNode, closeSidebarNode, addSidebarCard, openCommentsForNode } = useNodesStore();
  
  // Check if node is used as a type
  const { data: typedNodes } = useNodesWithType(node?.id ?? 0);
  
  // Section toolbar states - for pages
  const linkedRefsToolbarState = useLinkedReferencesState(nodeId);
  const { count: linkedRefsCount } = useLinkedReferencesCount(nodeId);
  const typedNodesToolbarState = useTypedNodesSectionState(node?.id ?? 0);
  const childPagesToolbarState = useChildPagesSectionState(node?.id ?? 0, node?.children?.filter(c => c.is_page));

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
  
  // Navigate to type/tag
  const handleNavigateToNode = useCallback((targetId: number) => {
    openNode(targetId, 'page');
  }, [openNode]);

  // Handle adding a type to a block
  const handleAddTypeToBlock = useCallback((blockId: number) => (typeNodeId: number, _keepInline: boolean, _typeName: string) => {
    addType.mutate({ nodeId: blockId, typeId: typeNodeId });
  }, [addType]);

  // Handle adding a tag to a block
  const handleAddTagToBlock = useCallback((blockId: number) => (tagNodeId: number, keepInline: boolean, _tagName: string) => {
    addTag.mutate({ nodeId: blockId, tagId: tagNodeId });
    if (keepInline) {
      addTagLink.mutate({ nodeId: blockId, targetNodeId: tagNodeId });
    }
  }, [addTag, addTagLink]);

  // Handle creating a new type
  const handleCreateTypeForBlock = useCallback((blockId: number) => (name: string) => {
    const typeType = allTypes?.find(t => t.name?.toLowerCase() === 'type');
    // Create as both a page AND a type so it shows up in @ menu
    createNode.mutate({ name, is_page: true, is_type: true }, {
      onSuccess: (newPage) => {
        addType.mutate({ nodeId: blockId, typeId: newPage.id });
        if (typeType) {
          addType.mutate({ nodeId: newPage.id, typeId: typeType.id });
        }
      }
    });
  }, [createNode, addType, allTypes]);

  // Handle creating a new tag
  const handleCreateTagForBlock = useCallback((blockId: number) => (name: string) => {
    createNode.mutate({ name, is_page: true }, {
      onSuccess: (newPage) => {
        addTag.mutate({ nodeId: blockId, tagId: newPage.id });
      }
    });
  }, [createNode, addTag]);

  // Handle creating a new page link (from [[ menu)
  const handleCreatePageLink = useCallback(async (name: string): Promise<string | undefined> => {
    try {
      const newPage = await createNode.mutateAsync({ name, is_page: true });
      return String(newPage.id);
    } catch (error) {
      console.error('Failed to create page for link:', error);
      return undefined;
    }
  }, [createNode]);

  // Handle opening comments
  const handleOpenComments = useCallback((blockId: number) => () => {
    openCommentsForNode(blockId);
  }, [openCommentsForNode]);
  
  // Page-level type/tag handlers
  const handleAddPageType = useCallback((typeNode: Node) => {
    if (!node) return;
    addType.mutate({ nodeId: node.id, typeId: typeNode.id });
  }, [node, addType]);
  
  const handleCreatePageType = useCallback((name: string) => {
    if (!node) return;
    const typeType = allTypes?.find(t => t.name?.toLowerCase() === 'type');
    createNode.mutate({ name, is_page: true, is_type: true }, {
      onSuccess: (newPage) => {
        addType.mutate({ nodeId: node.id, typeId: newPage.id });
        if (typeType) {
          addType.mutate({ nodeId: newPage.id, typeId: typeType.id });
        }
      }
    });
  }, [node, createNode, addType, allTypes]);
  
  const handleRemovePageType = useCallback((typeNode: Node) => {
    if (!node) return;
    removeType.mutate({ nodeId: node.id, typeId: typeNode.id });
  }, [node, removeType]);
  
  // Handle color change for type/tag nodes
  const handleNodeColorChange = useCallback((targetNode: Node, color: string | null) => {
    updateNode.mutate({ id: targetNode.id, data: { color } });
  }, [updateNode]);
  
  const handleAddPageTag = useCallback((tagNode: Node) => {
    if (!node) return;
    addTag.mutate({ nodeId: node.id, tagId: tagNode.id });
  }, [node, addTag]);
  
  const handleCreatePageTag = useCallback((name: string) => {
    if (!node) return;
    createNode.mutate({ name, is_page: true }, {
      onSuccess: (newPage) => {
        addTag.mutate({ nodeId: node.id, tagId: newPage.id });
      }
    });
  }, [node, createNode, addTag]);
  
  const handleRemovePageTag = useCallback((tagNode: Node) => {
    if (!node) return;
    removeTag.mutate({ nodeId: node.id, tagId: tagNode.id });
  }, [node, removeTag]);

  // Filter children - separate blocks from pages
  const { blockChildren, pageChildren } = useMemo(() => {
    if (!node?.children) return { blockChildren: [], pageChildren: [] };
    
    const blocks: Node[] = [];
    const pages: Node[] = [];
    
    for (const child of node.children) {
      // Skip children with this node as their type (they appear in TypedNodesView)
      if (child.types?.includes(node.id)) continue;
      
      if (child.is_page) {
        pages.push(child);
      } else {
        blocks.push(child);
      }
    }
    
    return { blockChildren: blocks, pageChildren: pages };
  }, [node?.children, node?.id]);
  
  // Resolve page type details from IDs
  const pageTypeDetails = useMemo(() => {
    if (!node?.types || node.types.length === 0) return [];
    return node.types
      .map(typeId => {
        const fromTypes = allTypes?.find(t => t.id === typeId);
        if (fromTypes) return fromTypes;
        return allNodes?.find(n => n.id === typeId);
      })
      .filter((t): t is Node => t !== undefined && t.uuid !== SYSTEM_TYPE_UUIDS.page);
  }, [node?.types, allTypes, allNodes]);
  
  // Resolve page tag details from IDs
  const pageTagDetails = useMemo(() => {
    if (!node?.tags || node.tags.length === 0) return [];
    return node.tags
      .map(tagId => {
        const fromTags = allTags?.find(t => t.id === tagId);
        if (fromTags) return fromTags;
        return allNodes?.find(n => n.id === tagId);
      })
      .filter((t): t is Node => {
        if (t === undefined) return false;
        if (t.is_type) return false;
        return true;
      });
  }, [node?.tags, allTags, allNodes]);
  
  // A node is a "type node" if it's in the types list OR has nodes using it as their type
  const isTypeNode = useMemo(() => {
    if (!node) return false;
    return (allTypes?.some(t => t.id === node.id) || (typedNodes && typedNodes.length > 0)) ?? false;
  }, [node, allTypes, typedNodes]);
  
  // Block callbacks for NodeCollection context
  const blockCallbacks = useMemo<BlockCallbacks>(() => ({
    onAddType: (blockId, typeNodeId, _keepInline, _typeName) => {
      addType.mutate({ nodeId: blockId, typeId: typeNodeId });
    },
    onAddTag: (blockId, tagNodeId, keepInline, _tagName) => {
      addTag.mutate({ nodeId: blockId, tagId: tagNodeId });
      if (keepInline) {
        addTagLink.mutate({ nodeId: blockId, targetNodeId: tagNodeId });
      }
    },
    onCreateType: (blockId, name, _keepInline) => {
      const typeType = allTypes?.find(t => t.name?.toLowerCase() === 'type');
      createNode.mutate({ name, is_page: true }, {
        onSuccess: (newPage) => {
          addType.mutate({ nodeId: blockId, typeId: newPage.id });
          if (typeType) {
            addType.mutate({ nodeId: newPage.id, typeId: typeType.id });
          }
        }
      });
    },
    onCreateTag: (blockId, name, _keepInline) => {
      createNode.mutate({ name, is_page: true }, {
        onSuccess: (newPage) => {
          addTag.mutate({ nodeId: blockId, tagId: newPage.id });
        }
      });
    },
    onCreatePageLink: async (name) => {
      try {
        const newPage = await createNode.mutateAsync({ name, is_page: true });
        return String(newPage.id);
      } catch (error) {
        console.error('Failed to create page for link:', error);
        return undefined;
      }
    },
    onOpenComments: (blockId) => {
      openCommentsForNode(blockId);
    },
    onOpenBacklinks: (blockId) => {
      addSidebarCard(blockId, 'block');
    },
    getCommentCount: (block) => block.comment_count ?? 0,
    getBacklinkCount: (block) => block.backlink_count ?? 0,
  }), [addType, addTag, addTagLink, createNode, allTypes, openCommentsForNode, addSidebarCard]);

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
      {/* Header - different for pages vs blocks, hidden when using SidebarCard wrapper */}
      {!hideHeader && nodeType === 'page' && (
        /* Page Header - card style with name and expand */
        <header className="sidebar-node-view__header sidebar-node-view__header--page">
          <div className="sidebar-node-view__title">
            {effectiveIcon || node.is_daily || node.is_monthly || node.is_yearly ? (
              <NodeIcon icon={effectiveIcon} isPage={true} size="sm" className="sidebar-node-view__icon" />
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
          <Button 
            className="sidebar-node-view__expand-btn"
            variant="ghost"
            size="sm"
            onClick={handleOpenFull}
            title="Open in main view"
          >
            ↗
          </Button>
        </header>
      )}
      {!hideHeader && nodeType === 'block' && (
        /* Block Header - editable block style */
        <header className="sidebar-node-view__header sidebar-node-view__header--block">
          <div className="sidebar-node-view__block-header-content">
            <span className="sidebar-node-view__bullet">•</span>
            <span className="sidebar-node-view__label">Block</span>
          </div>
          <Button 
            className="sidebar-node-view__expand-btn"
            variant="ghost"
            size="sm"
            onClick={handleOpenFull}
            title="Open in focused view"
          >
            ↗
          </Button>
        </header>
      )}

      {/* Content */}
      <div className="sidebar-node-view__content">
        {nodeType === 'page' && (
          /* Page content: Types, Tags, Properties, Children via NodeCollection, and sections */
          <>
            {/* Types Section */}
            <div className="sidebar-node-view__section sidebar-node-view__types">
              <NodePillRow
                nodes={pageTypeDetails}
                searchMode="types"
                emptyText="Add type"
                searchPlaceholder="Search types..."
                onNodeClick={(n) => handleNavigateToNode(n.id)}
                onRemove={handleRemovePageType}
                onColorChange={handleNodeColorChange}
                onAdd={handleAddPageType}
                onCreateNew={handleCreatePageType}
                canRemove={(n) => !isSystemTypeUuid(n.uuid)}
              />
            </div>
            
            {/* Tags Section */}
            <div className="sidebar-node-view__section sidebar-node-view__tags">
              <NodePillRow
                nodes={pageTagDetails}
                searchMode="tags"
                emptyText="Add tag"
                searchPlaceholder="Search tags..."
                onNodeClick={(n) => handleNavigateToNode(n.id)}
                onRemove={handleRemovePageTag}
                onColorChange={handleNodeColorChange}
                onAdd={handleAddPageTag}
                onCreateNew={handleCreatePageTag}
              />
            </div>
            
            {/* Properties Section - collapsed by default */}
            <div className="sidebar-node-view__section sidebar-node-view__properties">
              <PropertiesSection
                nodeId={node.id}
                variant="page"
                showHiddenSection={false}
                showAddProperty={true}
                onNavigateToNode={handleNavigateToNode}
                onOpenInSidebar={(id) => addSidebarCard(id, 'block')}
                defaultCollapsed={true}
              />
            </div>
            
            {/* Children blocks via NodeCollection - list view only */}
            {blockChildren.length > 0 && (
              <div className="sidebar-node-view__children">
                <NodeCollection
                  nodes={blockChildren}
                  viewMode="list"
                  availableViewModes={['list']}
                  editable={true}
                  onNodeClick={(clickedNode) => openNode(clickedNode.id, clickedNode.is_page ? 'page' : 'block')}
                  onNodeShiftClick={(clickedNode) => addSidebarCard(clickedNode.id, 'block')}
                  onContentChange={handleBlockChange}
                  showEmpty={false}
                  provideBlockCallbacks={true}
                  blockCallbacks={blockCallbacks}
                />
              </div>
            )}
            
            {/* Typed nodes section - collapsed by default */}
            {isTypeNode && (
              <NodeViewSection
                title="Nodes"
                icon={<TableIcon size="sm" />}
                count={typedNodes?.length ?? 0}
                defaultExpanded={false}
                hideWhenEmpty={true}
                headerActions={<TypedNodesSectionToolbar state={typedNodesToolbarState} />}
              >
                <TypedNodesView 
                  typeId={node.id} 
                  typeName={node.name || 'Untitled'} 
                  hideToolbar={true}
                  toolbarState={typedNodesToolbarState}
                />
              </NodeViewSection>
            )}
            
            {/* Child pages section - collapsed by default */}
            {pageChildren.length > 0 && (
              <NodeViewSection
                title="Children"
                icon={<PageIcon size="sm" />}
                count={pageChildren.length}
                defaultExpanded={false}
                headerActions={<ChildPagesSectionToolbar state={childPagesToolbarState} />}
              >
                <ChildPagesSection 
                  pageId={node.id} 
                  childPages={pageChildren} 
                  hideToolbar={true}
                  toolbarState={childPagesToolbarState}
                />
              </NodeViewSection>
            )}
            
            {/* Linked References - collapsed by default */}
            {useDynamicNodeViews ? (
              <DynamicNodeViewSection
                nodeId={node.id}
                nodeUuid={node.uuid}
                viewType="linked_references"
                title="Linked References"
                icon={<LinkIcon size="sm" />}
                defaultExpanded={false}
                hideWhenEmpty={true}
                onNodeClick={(targetId, isPage) => openNode(targetId, isPage ? 'page' : 'block')}
              />
            ) : (
              <NodeViewSection
                title="Linked References"
                icon={<LinkIcon size="sm" />}
                count={linkedRefsCount}
                defaultExpanded={false}
                hideWhenEmpty={true}
                headerActions={<LinkedReferencesToolbar state={linkedRefsToolbarState} />}
              >
                <LinkedReferences 
                  nodeId={node.id} 
                  hideToolbar={true}
                  toolbarState={linkedRefsToolbarState}
                  onLinkClick={(targetId, _pageId, isPage) => {
                    openNode(targetId, isPage ? 'page' : 'block');
                  }}
                />
              </NodeViewSection>
            )}
          </>
        )}
        
        {nodeType === 'block' && (
          /* For blocks, show the block itself as editable */
          <div className="sidebar-node-view__block-editor">
            <BlockEditor
              nodeId={node.id}
              content={node.name || ''}
              onChange={handleNameChange}
              onAddType={handleAddTypeToBlock(node.id)}
              onAddTag={handleAddTagToBlock(node.id)}
              onCreateType={handleCreateTypeForBlock(node.id)}
              onCreateTag={handleCreateTagForBlock(node.id)}
              onCreatePageLink={handleCreatePageLink}
              onOpenComments={handleOpenComments(node.id)}
              readOnly={false}
            />
          </div>
        )}

        {/* Block children (for block type only) */}
        {nodeType === 'block' && blockChildren.length > 0 && (
          <div className="sidebar-node-view__children">
            <div className="sidebar-node-view__children-label">Children</div>
            {blockChildren.slice(0, 5).map((child) => (
              <div key={child.id} className="sidebar-node-view__child">
                <Block
                  block={child}
                  children={child.children}
                  parentId={node.id}
                  onContentChange={handleBlockChange}
                  onBulletClick={handleBlockBulletClick}
                  onShiftClick={handleBlockShiftClick} 
                  onAddType={handleAddTypeToBlock(child.id)}
                  onAddTag={handleAddTagToBlock(child.id)}
                  onCreateType={handleCreateTypeForBlock(child.id)}
                  onCreateTag={handleCreateTagForBlock(child.id)}
                  onCreatePageLink={handleCreatePageLink}
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

      {/* Linked References for blocks only - already shown in page section via NodeViewSection */}
      {nodeType === 'block' && (
        <div className="sidebar-node-view__references">
          <LinkedReferences
            nodeId={node.id}
            onLinkClick={handleLinkClick}
            className="sidebar-node-view__linked-refs"
          />
        </div>
      )}

      {/* Footer */}
      <footer className="sidebar-node-view__footer">
        <span className="sidebar-node-view__meta">
          {new Date(node.write_date).toLocaleDateString()}
        </span>
        {nodeType === 'block' && node.page_id && (
          <Button 
            className="sidebar-node-view__page-link"
            variant="ghost"
            size="sm"
            onClick={() => { openNode(node.page_id!, 'page'); closeSidebarNode(); }}
          >
            View page
          </Button>
        )}
      </footer>
    </div>
  );
}

export default SidebarNodeView;
