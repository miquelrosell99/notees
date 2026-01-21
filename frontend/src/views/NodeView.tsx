/**
 * NodeView Component - Unified view for pages and blocks
 * 
 * Main component for displaying nodes with two variants:
 * - Page variant: Shows PageHeader, NodeContent with children, and sections
 * - Block variant: Shows the focused block as a top-level list item using NodeCollection
 *                  (only list view mode is available for blocks)
 * 
 * Structure:
 * - Page:
 *   1. BannerImage / PageHeader / CoverImage
 *   2. PropertiesSection - Node properties
 *   3. NodeContent - Children blocks (supports list/document/card views)
 *   4. Type-specific sections (TypedNodesView, ChildPagesSection)
 *   5. LinkedReferences
 *   6. NodeActivityLog
 * 
 * - Block:
 *   1. FocusedBlockContent - Block as top-level list item (list view only)
 *   2. LinkedReferences
 *   3. NodeActivityLog
 */
import { useState, useMemo, useCallback } from 'react';
import { useNode, useTypes, useNodesWithType, useUpdateNode, useAddTag, useAddType, useCreateNode, useProperties, useSetNodeProperty, useAddTagLink } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import type { ViewMode, NodeViewType } from '@/stores';

// Components
import { PageHeader } from '../components/PageHeader';
import { BannerImage } from '../components/BannerImage';
import { CoverImage } from '../components/CoverImage';
import { AssetUploadModal } from '../components/assets/AssetUploadModal';
import { NodeContent } from '../components/nodes/NodeContent';
import { NodeCollection } from '../components/nodes/NodeCollection';
import type { BlockCallbacks } from '../components/blocks/BlockCallbacksContext';
import { PageContextMenu, BlockContextMenu } from '../components/nodes/NodeContextMenu';
import { NodeViewSection } from '../components/nodes/NodeViewSection';
import { PropertiesSection } from '../components/PropertiesSection';
import { TypedNodesView } from '../components/TypedNodesSection';
import { TypePropertiesEditor } from '../components/TypePropertiesEditor';
import { ChildPagesSection } from '../components/ChildPagesSection';
import { NodeActivityLog, useActivityCount } from '../components/nodes/NodeActivityLog';
import { LinkedReferences, useLinkedReferencesCount } from '../components/LinkedReferences';
import { TableIcon, PageIcon, LinkIcon } from '../components/icons';
import { mdiHistory, mdiRefresh } from '@mdi/js';
import Icon from '@mdi/react';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import type { Asset } from '../api/assets';

import './NodeView.css';

/**
 * Check if a time is during "late night" hours (10PM - 4AM)
 */
function isLateNightTime(dateStr: string): boolean {
  const date = new Date(dateStr);
  const hour = date.getHours();
  return hour >= 22 || hour < 4;
}

/**
 * FocusedBlockContent - Renders a focused block as a top-level list item
 * 
 * Used when viewing a single block (not a page). The block itself is rendered
 * as the first item in a list view, with its children nested below it.
 * Only list view mode is available for focused blocks.
 */
interface FocusedBlockContentProps {
  node: Node;
  onAddSidebarCard: (nodeId: number) => void;
}

function FocusedBlockContent({ node, onAddSidebarCard }: FocusedBlockContentProps) {
  const createNode = useCreateNode();
  const updateNode = useUpdateNode();
  const addTag = useAddTag();
  const addType = useAddType();
  const addTagLink = useAddTagLink();
  const { data: allTypes } = useTypes();
  const { openCommentsForNode, openNode } = useNodesStore();
  
  // Handle content changes
  const handleContentChange = useCallback((blockId: number, content: string) => {
    updateNode.mutate({ id: blockId, data: { name: content } });
  }, [updateNode]);

  // Handle node click (navigate)
  const handleNodeClick = useCallback((clickedNode: Node) => {
    openNode(clickedNode.id, clickedNode.is_page ? 'page' : 'block');
  }, [openNode]);

  // Handle shift+click (open in sidebar)
  const handleNodeShiftClick = useCallback((clickedNode: Node) => {
    onAddSidebarCard(clickedNode.id);
  }, [onAddSidebarCard]);

  // Block callbacks for context provider
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
      onAddSidebarCard(blockId);
    },
    getCommentCount: (block) => block.comment_count ?? 0,
    getBacklinkCount: (block) => block.backlink_count ?? 0,
  }), [addType, addTag, addTagLink, createNode, allTypes, openCommentsForNode, onAddSidebarCard]);

  return (
    <div className="focused-block-content">
      <NodeCollection
        nodes={[node]}
        viewMode="list"
        availableViewModes={['list']}
        editable={true}
        onNodeClick={handleNodeClick}
        onNodeShiftClick={handleNodeShiftClick}
        onContentChange={handleContentChange}
        showEmpty={false}
        provideBlockCallbacks={true}
        blockCallbacks={blockCallbacks}
      />
    </div>
  );
}

interface NodeViewProps {
  /** Node ID to display */
  nodeId: number;
  /** Explicit node type (if not provided, will be inferred from node.is_page) */
  nodeType?: NodeViewType;
  /** View mode (document, etc.) */
  viewMode: ViewMode;
  /** If true, clicking the title navigates to the page instead of editing (for journal compact mode) */
  compactMode?: boolean;
  /** Whether the properties section is collapsed by default */
  propertiesCollapsed?: boolean;
  /** Whether the linked references section is collapsed by default */
  linkedRefsCollapsed?: boolean;
}

export function NodeView({ nodeId, nodeType, viewMode, compactMode = false, propertiesCollapsed = false, linkedRefsCollapsed = false }: NodeViewProps) {
  // Fetch the node
  const { data: node, isLoading, error } = useNode(nodeId, { 
    include_children: true, 
    include_properties: true,
    include_backlinks: true
  });
  
  // Hooks (needed for page header sections)
  const { data: allTypes } = useTypes();
  const { data: allProperties } = useProperties();
  const { addSidebarCard, openNode, contentDisplayMode, lateNightThoughtsFilter } = useNodesStore();
  
  // Check if node is used as a type
  const { data: typedNodes } = useNodesWithType(node?.id ?? 0);
  
  // Section metadata hooks
  const { count: linkedRefsCount } = useLinkedReferencesCount(nodeId);
  const { count: activityCount, refetch: refetchActivity } = useActivityCount(nodeId);
  
  // Context menu state
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  
  // Cover image picker state
  const [isCoverImagePickerOpen, setIsCoverImagePickerOpen] = useState(false);
  const setPropertyMutation = useSetNodeProperty();
  
  // Determine node type from the data if not explicitly provided
  const resolvedType: NodeViewType = nodeType ?? (node?.is_page ? 'page' : 'block');
  
  // A node is a "type node" if it's in the types list OR has nodes using it as their type
  const isTypeNode = useMemo(() => {
    if (!node) return false;
    return (allTypes?.some(t => t.id === node.id) || (typedNodes && typedNodes.length > 0)) ?? false;
  }, [node, allTypes, typedNodes]);
  
  // Find the cover property by UUID
  const coverProperty = useMemo(() => {
    return allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.cover);
  }, [allProperties]);
  
  // Get cover image ID from properties
  const coverImageId = useMemo(() => {
    const coverValue = node?.properties?.cover;
    return typeof coverValue === 'number' ? coverValue : null;
  }, [node?.properties]);
  
  // Find the banner property by UUID
  const bannerProperty = useMemo(() => {
    return allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.banner);
  }, [allProperties]);
  
  // Get banner image ID from properties
  const bannerImageId = useMemo(() => {
    const bannerValue = node?.properties?.banner;
    return typeof bannerValue === 'number' ? bannerValue : null;
  }, [node?.properties]);
  
  // Collect block IDs that are referenced by text properties (these should not appear in content)
  const textPropertyBlockIds = useMemo(() => {
    if (!node?.properties || !allProperties) return new Set<number>();
    
    const blockIds = new Set<number>();
    const nodeProps = node.properties as Record<string, unknown>;
    
    for (const prop of allProperties) {
      if (prop.type === 'text') {
        const key = prop.name.toLowerCase().replace(/\s+/g, '_');
        const value = nodeProps[key];
        if (typeof value === 'number') {
          blockIds.add(value);
        }
      }
    }
    
    return blockIds;
  }, [node?.properties, allProperties]);
  
  // Separate block children from page children
  const { blockChildren, pageChildren } = useMemo(() => {
    if (!node?.children) return { blockChildren: [], pageChildren: [] };
    
    const blocks: Node[] = [];
    const pages: Node[] = [];
    
    for (const child of node.children) {
      // Skip children with this node as their type (they appear in TypedNodesView)
      if (child.types?.includes(node.id)) continue;
      
      // Skip blocks that are referenced by text properties (they appear in PropertiesSection)
      if (textPropertyBlockIds.has(child.id)) continue;
      
      // Apply late night thoughts filter if enabled
      if (lateNightThoughtsFilter && child.create_date && !isLateNightTime(child.create_date)) {
        continue;
      }
      
      if (child.is_page) {
        pages.push(child);
      } else {
        blocks.push(child);
      }
    }
    
    return { blockChildren: blocks, pageChildren: pages };
  }, [node?.children, node?.id, textPropertyBlockIds, lateNightThoughtsFilter]);
  
  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  }, []);
  
  const handleCloseContextMenu = useCallback(() => {
    setShowContextMenu(false);
  }, []);
  
  // Navigate to type/tag
  const handleNavigateToNode = useCallback((targetId: number) => {
    openNode(targetId, 'page');
  }, [openNode]);
  
  // Cover image handlers
  const handleSelectCoverImage = useCallback(() => {
    setIsCoverImagePickerOpen(true);
  }, []);
  
  const handleCoverImageUploaded = useCallback((asset: { node_id?: number }) => {
    setIsCoverImagePickerOpen(false);
    if (coverProperty && 'node_id' in asset && asset.node_id && node) {
      setPropertyMutation.mutate({
        nodeId: node.id,
        propertyId: coverProperty.id,
        value: asset.node_id
      });
    }
  }, [node, coverProperty, setPropertyMutation]);
  
  // Banner image picker state
  const [isBannerImagePickerOpen, setIsBannerImagePickerOpen] = useState(false);
  
  // Banner image handlers
  const handleSelectBannerImage = useCallback(() => {
    setIsBannerImagePickerOpen(true);
  }, []);
  
  const handleBannerImageUploaded = useCallback((asset: Asset) => {
    setIsBannerImagePickerOpen(false);
    if (bannerProperty && 'node_id' in asset && asset.node_id && node) {
      setPropertyMutation.mutate({
        nodeId: node.id,
        propertyId: bannerProperty.id,
        value: asset.node_id
      });
    }
  }, [node, bannerProperty, setPropertyMutation]);
  
  // Block-only background style based on color (pages are colored at main-content level)
  // Note: Must be before early returns to maintain hooks order
  const nodeStyle = useMemo(() => {
    // Only apply inline color for blocks, not pages (pages color the main-content container)
    if (resolvedType === 'page' || !node?.color) return undefined;
    return {
      backgroundColor: node.color,
      '--node-bg-color': node.color,
    } as React.CSSProperties;
  }, [node?.color, resolvedType]);

  // Loading state
  if (isLoading) {
    return (
      <article className={`node-view node-view--loading ${viewMode}`}>
        <div className="loading-state">Loading...</div>
      </article>
    );
  }
  
  // Error state
  if (error || !node) {
    return (
      <article className={`node-view node-view--error ${viewMode}`}>
        <div className="error-state">Node not found</div>
      </article>
    );
  }

  return (
    <article 
      className={`node-view node-view--${resolvedType} ${viewMode}`} 
      style={nodeStyle}
    >
      {/* Page Header or Block Header based on variant */}
      {resolvedType === 'page' ? (
        <>
          {/* Banner Image - before entire header section */}
          <BannerImage
            pageId={node.id}
            bannerImageId={bannerImageId}
            onSelectImage={handleSelectBannerImage}
            editable={true}
            height="medium"
          />
          
          {/* Two-column layout: Header+Properties on left, Cover on right */}
          <div className="page-header-section">
            <div className="page-header-section__left">
              <PageHeader
                page={node}
                compactMode={compactMode}
                onContextMenu={handleContextMenu}
                onNavigateToNode={handleNavigateToNode}
              />
              
              {/* Properties Section - inside the left column */}
              <PropertiesSection 
                nodeId={node.id}
                variant={resolvedType}
                showHiddenSection={true}
                showAddProperty={true}
                onNavigateToNode={handleNavigateToNode}
                onOpenInSidebar={(id) => addSidebarCard(id, 'block')}
                defaultCollapsed={propertiesCollapsed}
              />
            </div>
            
            {/* Cover Image - right column */}
            <CoverImage
              pageId={node.id}
              coverImageId={coverImageId}
              onSelectImage={handleSelectCoverImage}
              editable={true}
            />
          </div>
          
          {/* Banner Image Picker Modal */}
          <AssetUploadModal
            isOpen={isBannerImagePickerOpen}
            onClose={() => setIsBannerImagePickerOpen(false)}
            onUpload={handleBannerImageUploaded}
            acceptedTypes={['image']}
          />
          
          {/* Cover Image Picker Modal */}
          <AssetUploadModal
            isOpen={isCoverImagePickerOpen}
            onClose={() => setIsCoverImagePickerOpen(false)}
            onUpload={handleCoverImageUploaded}
            acceptedTypes={['image']}
          />
        </>
      ) : null}
      

      
      {/* Type properties definition - only for type nodes (pages used as types) */}
      {isTypeNode && resolvedType === 'page' && (
        <TypePropertiesEditor typeNodeId={node.id} />
      )}
      
      {/* Node Content - Children blocks (pages only, blocks use focused block view) */}
      {resolvedType === 'page' ? (
        <NodeContent
          node={node}
          children={blockChildren}
          displayMode={contentDisplayMode}
          lateNightFilterActive={lateNightThoughtsFilter}
          totalChildrenCount={node.children?.length || 0}
        />
      ) : (
        /* Focused Block View - renders the block itself as a top-level list item */
        <FocusedBlockContent
          node={node}
          onAddSidebarCard={(id) => addSidebarCard(id, 'block')}
        />
      )}
      
      {/* Show nodes that have this node as their type - only for type nodes */}
      {isTypeNode && (
        <NodeViewSection
          title="Nodes"
          icon={<TableIcon size="sm" />}
          count={typedNodes?.length ?? 0}
          defaultExpanded={true}
          hideWhenEmpty={true}
        >
          <TypedNodesView typeId={node.id} typeName={node.name || 'Untitled'} />
        </NodeViewSection>
      )}
      
      {/* Child pages section - shows pages that have this node as parent (pages only) */}
      {resolvedType === 'page' && pageChildren.length > 0 && (
        <NodeViewSection
          title="Children"
          icon={<PageIcon size="sm" />}
          count={pageChildren.length}
          defaultExpanded={true}
        >
          <ChildPagesSection pageId={node.id} childPages={pageChildren} />
        </NodeViewSection>
      )}
      
      {/* Linked References - shows all references to this node (universal for all nodes) */}
      <NodeViewSection
        title="Linked References"
        icon={<LinkIcon size="sm" />}
        count={linkedRefsCount}
        defaultExpanded={!linkedRefsCollapsed}
        hideWhenEmpty={true}
      >
        <LinkedReferences 
          nodeId={node.id} 
          onLinkClick={(nodeId, pageId, isPage) => {
            // Open the block's page if available, otherwise open the node directly
            if (pageId) {
              openNode(pageId, 'page');
            } else {
              openNode(nodeId, isPage ? 'page' : 'block');
            }
          }}
        />
      </NodeViewSection>
      
      {/* Node Activity Log - pages only */}
      {resolvedType === 'page' && (
        <NodeViewSection
          title="Activity"
          icon={<Icon path={mdiHistory} size={0.7} />}
          count={activityCount}
          defaultExpanded={false}
          headerActions={
            <button
              className="node-activity-btn"
              onClick={(e) => { e.stopPropagation(); refetchActivity(); }}
              title="Refresh"
            >
              <Icon path={mdiRefresh} size={0.6} />
            </button>
          }
        >
          <NodeActivityLog nodeId={node.id} />
        </NodeViewSection>
      )}
      
      {/* Footer */}
      <footer className="node-view-footer">
        <div className="node-view-metadata">
          <span>Created: {new Date(node.create_date).toLocaleDateString()}</span>
          <span>Updated: {new Date(node.write_date).toLocaleDateString()}</span>
        </div>
      </footer>
      
      {/* Context Menu */}
      {showContextMenu && (
        resolvedType === 'page' ? (
          <PageContextMenu
            node={node}
            position={contextMenuPos}
            onClose={handleCloseContextMenu}
          />
        ) : (
          <BlockContextMenu
            node={node}
            position={contextMenuPos}
            onClose={handleCloseContextMenu}
          />
        )
      )}
    </article>
  );
}

export default NodeView;
