/**
 * SidebarNodeView Component
 * 
 * A minified version of NodeView for displaying nodes in the sidebar.
 * - Pages: Shows classes, tags, properties (collapsed), children blocks (list view),
 *   and additional sections (classed nodes, children pages, linked refs) collapsed
 * - Blocks: Shows the block itself as an editable block (like focused block mode),
 *   followed by its children and linked references
 */
import { useMemo, useCallback } from 'react';
import { 
  useNode, 
  useUpdateNode, 
  useAddTag, 
  useAddClass, 
  useAddTagLink, 
  useCreateNode, 
  useClasses,
  useTags,
  useNodes,
  useRemoveClass,
  useRemoveTag,
  useNodesWithClass,
  useLinkedReferencesCount,
} from '@/hooks';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { useNodesStore } from '@/stores';
import type { NodeUpdate, Node } from '@/types';
import type { SidebarNodeType } from '@/stores';
import type { BlockCallbacks } from '../blocks/BlockCallbacksContext';
import { BlockEditor } from '../blocks/BlockEditor';
import { Block } from '../blocks/Block';
import { NodeCollection } from '../nodes/NodeCollection';
import { PropertiesSection } from '../PropertiesSection';
import { NodePillRow } from '../NodePillRow';
import { DynamicNodeViewSection } from '../nodes';
import { NodeIcon, TableIcon, PageIcon, LinkIcon } from '../icons';
import { Button } from '../core/Button';
import { TextField } from '../core/TextField';
import { SYSTEM_CLASS_UUIDS, isSystemClassUuid } from '@/constants';
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
  
  const updateNode = useUpdateNode();
  const createNode = useCreateNode();
  const addTag = useAddTag();
  const addClass = useAddClass();
  const addTagLink = useAddTagLink();
  const removeClass = useRemoveClass();
  const removeTag = useRemoveTag();
  const { data: allClasses } = useClasses();
  const { data: allTags } = useTags();
  const { data: allNodes } = useNodes({ pages_only: true });
  const { openNode, closeSidebarNode, addSidebarCard, openCommentsForNode } = useNodesStore();
  
  // Check if node is used as a class
  const { data: classedNodes } = useNodesWithClass(node?.id ?? 0);
  
  // Linked references count (triggers data fetch)
  useLinkedReferencesCount(nodeId);

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
  
  // Navigate to class/tag
  const handleNavigateToNode = useCallback((targetId: number) => {
    openNode(targetId, 'page');
  }, [openNode]);

  // Handle adding a class to a block
  const handleAddClassToBlock = useCallback((blockId: number) => (classNodeId: number, _keepInline: boolean, _className: string) => {
    addClass.mutate({ nodeId: blockId, classId: classNodeId });
  }, [addClass]);

  // Handle adding a tag to a block
  const handleAddTagToBlock = useCallback((blockId: number) => (tagNodeId: number, keepInline: boolean, _tagName: string) => {
    addTag.mutate({ nodeId: blockId, tagId: tagNodeId });
    if (keepInline) {
      addTagLink.mutate({ nodeId: blockId, targetNodeId: tagNodeId });
    }
  }, [addTag, addTagLink]);

  // Handle creating a new class
  const handleCreateClassForBlock = useCallback((blockId: number) => (name: string) => {
    const classClass = allClasses?.find(t => t.name?.toLowerCase() === 'class');
    // Create as both a page AND a class so it shows up in @ menu
    createNode.mutate({ name, is_page: true, is_type: true }, {
      onSuccess: (newPage) => {
        addClass.mutate({ nodeId: blockId, classId: newPage.id });
        if (classClass) {
          addClass.mutate({ nodeId: newPage.id, classId: classClass.id });
        }
      }
    });
  }, [createNode, addClass, allClasses]);

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
  
  // Page-level class/tag handlers
  const handleAddPageClass = useCallback((classNode: Node) => {
    if (!node) return;
    addClass.mutate({ nodeId: node.id, classId: classNode.id });
  }, [node, addClass]);
  
  const handleCreatePageClass = useCallback((name: string) => {
    if (!node) return;
    const classClass = allClasses?.find(t => t.name?.toLowerCase() === 'class');
    createNode.mutate({ name, is_page: true, is_type: true }, {
      onSuccess: (newPage) => {
        addClass.mutate({ nodeId: node.id, classId: newPage.id });
        if (classClass) {
          addClass.mutate({ nodeId: newPage.id, classId: classClass.id });
        }
      }
    });
  }, [node, createNode, addClass, allClasses]);
  
  const handleRemovePageClass = useCallback((classNode: Node) => {
    if (!node) return;
    removeClass.mutate({ nodeId: node.id, classId: classNode.id });
  }, [node, removeClass]);
  
  // Handle color change for class/tag nodes
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
      // Skip children with this node as their class (they appear in typed_nodes view)
      if (child.classes?.includes(node.id)) continue;
      
      if (child.is_page) {
        pages.push(child);
      } else {
        blocks.push(child);
      }
    }
    
    return { blockChildren: blocks, pageChildren: pages };
  }, [node?.children, node?.id]);
  
  // Resolve page class details from IDs
  const pageClassDetails = useMemo(() => {
    if (!node?.classes || node.classes.length === 0) return [];
    return node.classes
      .map(classId => {
        const fromClasses = allClasses?.find(t => t.id === classId);
        if (fromClasses) return fromClasses;
        return allNodes?.find(n => n.id === classId);
      })
      .filter((t): t is Node => t !== undefined && t.uuid !== SYSTEM_CLASS_UUIDS.page);
  }, [node?.classes, allClasses, allNodes]);
  
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
  
  // A node is a "class node" if it's in the classes list OR has nodes using it as their class
  const isClassNode = useMemo(() => {
    if (!node) return false;
    return (allClasses?.some(t => t.id === node.id) || (classedNodes && classedNodes.length > 0)) ?? false;
  }, [node, allClasses, classedNodes]);
  
  // Block callbacks for NodeCollection context
  const blockCallbacks = useMemo<BlockCallbacks>(() => ({
    onAddClass: (blockId, classNodeId, _keepInline, _className) => {
      addClass.mutate({ nodeId: blockId, classId: classNodeId });
    },
    onAddTag: (blockId, tagNodeId, keepInline, _tagName) => {
      addTag.mutate({ nodeId: blockId, tagId: tagNodeId });
      if (keepInline) {
        addTagLink.mutate({ nodeId: blockId, targetNodeId: tagNodeId });
      }
    },
    onCreateClass: (blockId, name, _keepInline) => {
      const classClass = allClasses?.find(t => t.name?.toLowerCase() === 'class');
      createNode.mutate({ name, is_page: true }, {
        onSuccess: (newPage) => {
          addClass.mutate({ nodeId: blockId, classId: newPage.id });
          if (classClass) {
            addClass.mutate({ nodeId: newPage.id, classId: classClass.id });
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
  }), [addClass, addTag, addTagLink, createNode, allClasses, openCommentsForNode, addSidebarCard]);

  // Get effective icon (node's icon or first class's icon)
  const effectiveIcon = useMemo(() => getEffectiveIcon(node, allClasses), [node, allClasses]);

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
            <TextField
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
          /* Page content: Classes, Tags, Properties, Children via NodeCollection, and sections */
          <>
            {/* Classes Section */}
            <div className="sidebar-node-view__section sidebar-node-view__classes">
              <NodePillRow
                nodes={pageClassDetails}
                searchMode="classes"
                emptyText="Add class"
                searchPlaceholder="Search classes..."
                onNodeClick={(n) => handleNavigateToNode(n.id)}
                onRemove={handleRemovePageClass}
                onColorChange={handleNodeColorChange}
                onAdd={handleAddPageClass}
                onCreateNew={handleCreatePageClass}
                canRemove={(n) => !isSystemClassUuid(n.uuid)}
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
            
            {/* Classed nodes section - collapsed by default */}
            {isClassNode && (
              <DynamicNodeViewSection
                nodeId={node.id}
                nodeUuid={node.uuid}
                viewType="typed_nodes"
                title="Nodes"
                icon={<TableIcon size="sm" />}
                hideWhenEmpty={true}
                defaultExpanded={false}
                onNodeClick={(targetNodeId) => openNode(targetNodeId, 'page')}
                onBlockCreated={(targetNodeId) => addSidebarCard(targetNodeId, 'block')}
              />
            )}
            
            {/* Child pages section - collapsed by default */}
            {pageChildren.length > 0 && (
              <DynamicNodeViewSection
                nodeId={node.id}
                nodeUuid={node.uuid}
                viewType="child_pages"
                title="Children"
                icon={<PageIcon size="sm" />}
                hideWhenEmpty={true}
                defaultExpanded={false}
                onNodeClick={(targetNodeId) => openNode(targetNodeId, 'page')}
                onBlockCreated={(targetNodeId) => addSidebarCard(targetNodeId, 'block')}
              />
            )}
            
            {/* Linked References - collapsed by default */}
            <DynamicNodeViewSection
              nodeId={node.id}
              nodeUuid={node.uuid}
              viewType="linked_references"
              title="Linked References"
              icon={<LinkIcon size="sm" />}
              defaultExpanded={false}
              hideWhenEmpty={true}
              onNodeClick={(targetId, isPage) => openNode(targetId, isPage ? 'page' : 'block')}
              onBlockCreated={(targetId) => addSidebarCard(targetId, 'block')}
            />
          </>
        )}
        
        {nodeType === 'block' && (
          /* For blocks, show the block itself as editable */
          <div className="sidebar-node-view__block-editor">
            <BlockEditor
              nodeId={node.id}
              content={node.name || ''}
              onChange={handleNameChange}
              onAddClass={handleAddClassToBlock(node.id)}
              onAddTag={handleAddTagToBlock(node.id)}
              onCreateClass={handleCreateClassForBlock(node.id)}
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
                  onAddClass={handleAddClassToBlock(child.id)}
                  onAddTag={handleAddTagToBlock(child.id)}
                  onCreateClass={handleCreateClassForBlock(child.id)}
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
          <DynamicNodeViewSection
            nodeId={node.id}
            nodeUuid={node.uuid}
            viewType="linked_references"
            title="Linked References"
            icon={<LinkIcon size="sm" />}
            hideWhenEmpty={true}
            defaultExpanded={false}
            onBlockCreated={(targetId) => addSidebarCard(targetId, 'block')}
            onNodeClick={(targetId, isPage) => openNode(targetId, isPage ? 'page' : 'block')}
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
