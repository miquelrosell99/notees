/**
 * NodeView Component - Unified view for pages and blocks
 * 
 * Main component for displaying nodes with two variants:
 * - Page variant: Shows PageHeader for the parent node
 * - Block variant: Shows the focused block as a normal block (BlockHeader)
 * 
 * Structure:
 * 1. NodeBreadcrumbs - Navigation (for pages: only visible if has parent)
 * 2. PageHeader / BlockHeader - Main node display
 * 3. PropertiesSection - Node properties
 * 4. NodeContent - Children blocks
 * 5. Type-specific sections (TypedNodesView, ChildPagesSection)
 * 6. LinkedReferences
 * 7. NodeActivityLog
 */
import { useState, useMemo, useCallback } from 'react';
import { useNode, useTypes, useNodesWithType, useUpdateNode, useAddTag, useAddType, useCreateNode, useProperties, useSetNodeProperty, useAddTagLink } from '@/hooks';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { useNodesStore } from '@/stores';
import type { Node, NodeUpdate } from '@/types';
import type { ViewMode, NodeViewType } from '@/stores';

// Components
import { PageHeader } from '../components/PageHeader';
import { BannerImage } from '../components/BannerImage';
import { CoverImage } from '../components/CoverImage';
import { AssetUploadModal } from '../components/assets/AssetUploadModal';
import { NodeContent } from '../components/nodes/NodeContent';
import { PageContextMenu, BlockContextMenu } from '../components/nodes/NodeContextMenu';
import { NodeViewSection } from '../components/nodes/NodeViewSection';
import { PropertiesSection } from '../components/PropertiesSection';
import { TypedNodesView } from '../components/TypedNodesSection';
import { TypePropertiesEditor } from '../components/TypePropertiesEditor';
import { ChildPagesSection } from '../components/ChildPagesSection';
import { NodeActivityLog, useActivityCount } from '../components/nodes/NodeActivityLog';
import { LinkedReferences, useLinkedReferencesCount } from '../components/LinkedReferences';
import { BlockEditor } from '../components/blocks/BlockEditor';
import { ColorPicker } from '../components/core/ColorPicker';
import { Button } from '../components/core/Button';
import { NodeIcon, TagIcon, TableIcon, PageIcon, LinkIcon } from '../components/icons';
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
  
  // Hooks
  const updateNode = useUpdateNode();
  const createNode = useCreateNode();
  const addTag = useAddTag();
  const addTagLink = useAddTagLink();
  const addType = useAddType();
  const { data: allTypes } = useTypes();
  const { data: allProperties } = useProperties();
  const { addSidebarCard, openNode, openCommentsForNode, contentDisplayMode, lateNightThoughtsFilter } = useNodesStore();
  
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
  
  // Resolve type details from IDs
  const nodeTypeDetails = useMemo(() => {
    if (!node?.types || node.types.length === 0 || !allTypes) return [];
    return node.types
      .map(typeId => allTypes.find(t => t.id === typeId))
      .filter((t): t is Node => t !== undefined);
  }, [node?.types, allTypes]);
  
  // Get effective icon (node's icon or first type's icon)
  const effectiveIcon = useMemo(() => getEffectiveIcon(node, allTypes), [node, allTypes]);
  
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
  
  // Block header handlers
  const handleBlockNameChange = useCallback((name: string) => {
    if (!node) return;
    const data: NodeUpdate = { name };
    updateNode.mutate({ id: node.id, data });
  }, [node, updateNode]);
  
  const handleBlockColorChange = useCallback((color: string | null) => {
    if (!node) return;
    const data: NodeUpdate = { color };
    updateNode.mutate({ id: node.id, data });
  }, [node, updateNode]);
  
  // Handle adding a type to the block
  const handleAddType = useCallback((typeNodeId: number, _keepInline: boolean, _typeName: string) => {
    if (!node) return;
    addType.mutate({ nodeId: node.id, typeId: typeNodeId });
  }, [node, addType]);
  
  // Handle adding a tag to the block
  const handleAddTag = useCallback((tagNodeId: number, keepInline: boolean, _tagName: string) => {
    if (!node) return;
    // Always add to the tags property
    addTag.mutate({ nodeId: node.id, tagId: tagNodeId });
    
    // If kept inline, also mark the link as a tag
    if (keepInline) {
      addTagLink.mutate({ nodeId: node.id, targetNodeId: tagNodeId });
    }
  }, [node, addTag, addTagLink]);
  
  // Handle creating a new type
  const handleCreateType = useCallback((name: string) => {
    if (!node) return;
    const typeType = allTypes?.find(t => t.name?.toLowerCase() === 'type');
    
    // Create as both a page AND a type so it shows up in @ menu
    createNode.mutate({ name, is_page: true, is_type: true }, {
      onSuccess: (newPage) => {
        addType.mutate({ nodeId: node.id, typeId: newPage.id });
        if (typeType) {
          addType.mutate({ nodeId: newPage.id, typeId: typeType.id });
        }
      }
    });
  }, [node, createNode, addType, allTypes]);
  
  // Handle creating a new tag
  const handleCreateTag = useCallback((name: string) => {
    if (!node) return;
    createNode.mutate({ name, is_page: true }, {
      onSuccess: (newPage) => {
        addTag.mutate({ nodeId: node.id, tagId: newPage.id });
      }
    });
  }, [node, createNode, addTag]);
  
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
  const handleOpenComments = useCallback(() => {
    if (!node) return;
    openCommentsForNode(node.id);
  }, [node, openCommentsForNode]);
  
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
      ) : (
        /* Block Header - displays block as a normal block with editing */
        <header className="block-view-header" onContextMenu={handleContextMenu}>
          <span className="block-view-bullet">
            {effectiveIcon ? (
              <NodeIcon icon={effectiveIcon} isPage={false} size="sm" className="block-icon" />
            ) : (
              '•'
            )}
          </span>
          <div className="block-view-title-container">
            <BlockEditor
              nodeId={node.id}
              content={node.name || ''}
              onChange={handleBlockNameChange}
              onAddType={handleAddType}
              onAddTag={handleAddTag}
              onCreateType={handleCreateType}
              onCreateTag={handleCreateTag}
              onCreatePageLink={handleCreatePageLink}
              onOpenComments={handleOpenComments}
              readOnly={false}
            />
            {node.active === false && (
              <span className="archived-badge">Archived</span>
            )}
          </div>
          <div className="block-view-actions">
            <ColorPicker
              value={node.color}
              onChange={handleBlockColorChange}
              size="sm"
              panelPosition="bottom"
              tooltip="Block color"
            />
          </div>
        </header>
      )}
      
      {/* Block-level types and tags (only for block variant, page header handles its own) */}
      {resolvedType === 'block' && ((nodeTypeDetails.length > 0) || (node.tags && node.tags.length > 0)) && (
        <div className="node-metadata-chips">
          {nodeTypeDetails.length > 0 && (
            <div className="node-types">
              {nodeTypeDetails.map((typeNode) => (
                <Button
                  key={typeNode.id}
                  variant="ghost"
                  size="xs"
                  className="node-type-chip"
                  onClick={() => handleNavigateToNode(typeNode.id)}
                  title={`Click to view ${typeNode.name}`}
                >
                  <NodeIcon icon={typeNode.icon} isPage={true} size="xs" />
                  <span>{typeNode.name}</span>
                </Button>
              ))}
            </div>
          )}
          {node.tags && node.tags.length > 0 && (
            <div className="node-tags">
              {node.tags.map((tagId) => (
                <Button
                  key={tagId}
                  variant="ghost"
                  size="xs"
                  className="node-tag-chip"
                  onClick={() => handleNavigateToNode(tagId)}
                  title="Click to view tag page"
                >
                  <TagIcon size="xs" />
                  <span>Tag #{tagId}</span>
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
      
      {/* Properties Section - only for block variant (page variant has it in the header section) */}
      {resolvedType === 'block' && (
        <PropertiesSection 
          nodeId={node.id}
          variant={resolvedType}
          showHiddenSection={true}
          showAddProperty={true}
          onNavigateToNode={handleNavigateToNode}
          onOpenInSidebar={(id) => addSidebarCard(id, 'block')}
          defaultCollapsed={propertiesCollapsed}
        />
      )}
      
      {/* Type properties definition - only for type nodes (pages used as types) */}
      {isTypeNode && resolvedType === 'page' && (
        <TypePropertiesEditor typeNodeId={node.id} />
      )}
      
      {/* Node Content - Children blocks */}
      <NodeContent
        node={node}
        children={blockChildren}
        displayMode={contentDisplayMode}
        lateNightFilterActive={lateNightThoughtsFilter}
        totalChildrenCount={node.children?.length || 0}
      />
      
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
      
      {/* Node Activity Log */}
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
