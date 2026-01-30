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
 *   4. Class-specific sections using DynamicNodeViewSection
 *   5. LinkedReferences
 *   6. NodeActivityLogSection
 * 
 * - Block:
 *   1. FocusedBlockContent - Block as top-level list item (list view only)
 *   2. LinkedReferences
 */
import { useState, useMemo, useCallback } from 'react';
import { useNode, useClasses, useNodesWithClass, useUpdateNode, useAddTag, useAddClass, useCreateNode, useProperties, useSetNodeProperty, useAddTagLink, useRemoveClass, useRemoveTag, useNodes, useTags, useContentSave, useExtendedByClasses, useLinkedReferencesCount, usePageClass } from '@/hooks';
import { useNodesStore, useSettingsStore, formatDate } from '@/stores';
import type { Node } from '@/types';
import type { ViewMode, NodeViewType } from '@/stores';

// Components
import { PageHeader } from '../components/PageHeader';
import { NodePillRow } from '../components/NodePillRow';
import { BannerImage } from '../components/BannerImage';
import { CoverImage } from '../components/CoverImage';
import { AssetUploadModal } from '../components/assets/AssetUploadModal';
import { NodeContent } from '../components/nodes/NodeContent';
import { NodeCollection } from '../components/nodes/NodeCollection';
import type { BlockCallbacks } from '../components/blocks/BlockCallbacksContext';
import { PageContextMenu, BlockContextMenu } from '../components/nodes/NodeContextMenu';
import { NodeViewSection, DynamicNodeViewSection } from '../components/nodes';
import { PropertiesSection } from '../components/PropertiesSection';
import { ClassPropertiesEditor } from '../components/ClassPropertiesEditor';
import { TableIcon, PageIcon, LinkIcon } from '../components/icons';
import { SYSTEM_PROPERTY_UUIDS, SYSTEM_CLASS_UUIDS, isSystemClassUuid, isBlockOnlyClass } from '@/constants';
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
  const addTag = useAddTag();
  const addClass = useAddClass();
  const addTagLink = useAddTagLink();
  const { data: allClasses } = useClasses();
  const { pageClassId } = usePageClass();
  const { openCommentsForNode, openNode } = useNodesStore();
  
  // Debounced content save - batches rapid edits to reduce API calls
  const { handleContentChange } = useContentSave();

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
    onAddClass: (blockId: number, classNodeId: number, _keepInline: boolean, _className: string) => {
      addClass.mutate({ nodeId: blockId, classId: classNodeId });
    },
    onAddTag: (blockId: number, tagNodeId: number, keepInline: boolean, _tagName: string) => {
      addTag.mutate({ nodeId: blockId, tagId: tagNodeId });
      if (keepInline) {
        addTagLink.mutate({ nodeId: blockId, targetNodeId: tagNodeId });
      }
    },
    onCreateClass: (blockId: number, name: string, _keepInline: boolean) => {
      const classClass = allClasses?.find(c => c.name?.toLowerCase() === 'class');
      if (!pageClassId) return;
      createNode.mutate({ name, classes: [pageClassId] }, {
        onSuccess: (newPage) => {
          addClass.mutate({ nodeId: blockId, classId: newPage.id });
          if (classClass) {
            addClass.mutate({ nodeId: newPage.id, classId: classClass.id });
          }
        }
      });
    },
    onCreateTag: (blockId: number, name: string, _keepInline: boolean) => {
      if (!pageClassId) return;
      createNode.mutate({ name, classes: [pageClassId] }, {
        onSuccess: (newPage) => {
          addTag.mutate({ nodeId: blockId, tagId: newPage.id });
        }
      });
    },
    onCreatePageLink: async (name) => {
      try {
        if (!pageClassId) return undefined;
        const newPage = await createNode.mutateAsync({ name, classes: [pageClassId] });
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
  }), [addClass, addTag, addTagLink, createNode, allClasses, openCommentsForNode, onAddSidebarCard]);

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
        suppressRootColor={true}
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
  const { data: allClasses } = useClasses();
  const { data: allTags } = useTags();
  const { data: allNodes } = useNodes({ pages_only: true });  // For fallback class/tag lookup
  const { data: allProperties } = useProperties();
  const { pageClassId } = usePageClass();
  const { addSidebarCard, openNode, contentDisplayMode, lateNightThoughtsFilter } = useNodesStore();
  const updateNode = useUpdateNode();
  const removeClass = useRemoveClass();
  const addClass = useAddClass();
  const removeTag = useRemoveTag();
  const addTag = useAddTag();
  const createNode = useCreateNode();
  
  // Resolve page class details from IDs (excluding the implicit "page" class)
  // For system classes (like "day", "month", etc.), we show their "class" class but make it non-removable
  // Use allNodes as fallback for system classes that might not be in allClasses
  const pageClassDetails = useMemo(() => {
    if (!node?.classes) return [];
    const classIds = node.classes;
    return classIds
      .map((classId: number) => {
        // First try allClasses, then fallback to allNodes
        const fromClasses = allClasses?.find(t => t.id === classId);
        if (fromClasses) return fromClasses;
        return allNodes?.find(n => n.id === classId);
      })
      // Exclude the implicit "page" class (all pages have it)
      .filter((t): t is Node => t !== undefined && t.uuid !== SYSTEM_CLASS_UUIDS.page);
  }, [node?.classes, allClasses, allNodes]);
  
  // Resolve page tag details from IDs (excluding class definitions)
  const pageTagDetails = useMemo(() => {
    if (!node?.tags || node.tags.length === 0) return [];
    return node.tags
      .map(tagId => {
        // First try allTags, then fallback to allNodes
        const fromTags = allTags?.find(t => t.id === tagId);
        if (fromTags) return fromTags;
        return allNodes?.find(n => n.id === tagId);
      })
      .filter((t): t is Node => {
        if (t === undefined) return false;
        // Hide class definitions (they shouldn't show as tags)
        if (t.is_class) return false;
        return true;
      });
  }, [node?.tags, allTags, allNodes]);
  
  // Handle adding a class via NodePillRow
  const handleAddClass = useCallback((classNode: Node) => {
    if (!node) return;
    addClass.mutate({ nodeId: node.id, classId: classNode.id });
  }, [node, addClass]);
  
  // Handle creating a new class via NodePillRow
  const handleCreateClass = useCallback((name: string) => {
    if (!node) return;
    const classClass = allClasses?.find(t => t.uuid === SYSTEM_CLASS_UUIDS.class);
    const pageClass = allClasses?.find(t => t.uuid === SYSTEM_CLASS_UUIDS.page);
    
    // Create with Page and Class classes - backend will compute is_page and is_class flags
    const classes = [];
    if (pageClass) classes.push(pageClass.id);
    if (classClass) classes.push(classClass.id);
    
    createNode.mutate({ name, classes }, {
      onSuccess: (newPage) => {
        // Add the new class to the current node
        addClass.mutate({ nodeId: node.id, classId: newPage.id });
      }
    });
  }, [node, createNode, addClass, allClasses]);
  
  // Handle removing a class via NodePillRow
  const handleRemoveClass = useCallback((classNode: Node) => {
    if (!node) return;
    removeClass.mutate({ nodeId: node.id, classId: classNode.id });
  }, [node, removeClass]);
  
  // Handle adding a tag via NodePillRow
  const handleAddTag = useCallback((tagNode: Node) => {
    if (!node) return;
    addTag.mutate({ nodeId: node.id, tagId: tagNode.id });
  }, [node, addTag]);
  
  // Handle creating a new tag via NodePillRow
  const handleCreateTag = useCallback((name: string) => {
    if (!node || !pageClassId) return;
    // Create as a page (tags are just pages linked to nodes)
    createNode.mutate({ name, classes: [pageClassId] }, {
      onSuccess: (newPage) => {
        addTag.mutate({ nodeId: node.id, tagId: newPage.id });
      }
    });
  }, [node, createNode, addTag, pageClassId]);
  
  // Handle removing a tag via NodePillRow
  const handleRemoveTag = useCallback((tagNode: Node) => {
    if (!node) return;
    removeTag.mutate({ nodeId: node.id, tagId: tagNode.id });
  }, [node, removeTag]);
  
  // Handle color change for class/tag nodes via NodePillRow
  const handleNodeColorChange = useCallback((targetNode: Node, color: string | null) => {
    updateNode.mutate({ id: targetNode.id, data: { color } });
  }, [updateNode]);
  
  // Check if node is used as a class
  const { data: classedNodes } = useNodesWithClass(node?.id ?? 0);
  
  // Section metadata hooks
  useLinkedReferencesCount(nodeId);
  
  // Context menu state
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  
  // Cover image picker state
  const [isCoverImagePickerOpen, setIsCoverImagePickerOpen] = useState(false);
  const setPropertyMutation = useSetNodeProperty();
  
  // Determine node type from the data if not explicitly provided
  const resolvedType: NodeViewType = nodeType ?? (node?.is_page ? 'page' : 'block');
  
  // A node is a "class node" if it's in the classes list OR has nodes using it as their class
  const isClassNode = useMemo(() => {
    if (!node) return false;
    return (allClasses?.some(t => t.id === node.id) || (classedNodes && classedNodes.length > 0)) ?? false;
  }, [node, allClasses, classedNodes]);
  
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
  const { blockChildren } = useMemo(() => {
    if (!node?.children) return { blockChildren: [], pageChildren: [] };
    
    const blocks: Node[] = [];
    const pages: Node[] = [];
    
    for (const child of node.children) {
      // Skip children with this node as their class (they appear in classed_nodes view)
      if (child.classes?.includes(node.id)) continue;
      
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
  
  // Note: Color styling for both pages and focused blocks is now handled 
  // at the main-content level in MainContent.tsx for consistency

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
    >
      {/* Page Header or Block Header based on variant */}
      {resolvedType === 'page' ? (
        <>
          {/* Banner Image - before entire header section */}
          <BannerImage
            pageId={node.id}
            bannerImageId={bannerImageId}
            onSelectImage={handleSelectBannerImage}
            onImageUploaded={handleBannerImageUploaded}
            editable={true}
            height="medium"
          />
          
          {/* Grid layout: Header content on left | Cover spanning all rows on right */}
          <div className="page-header-section">
            {/* Row 1: Page Header (title + icon) */}
            <div className="page-header-section__header">
              <PageHeader
                page={node}
                compactMode={compactMode}
                onContextMenu={handleContextMenu}
              />
            </div>
            
            {/* Row 2: Classes */}
            <div className="page-header-section__types">
              <NodePillRow
                nodes={pageClassDetails}
                searchMode="classes"
                emptyText="Add class"
                searchPlaceholder="Search classes..."
                onNodeClick={(n) => handleNavigateToNode(n.id)}
                onRemove={handleRemoveClass}
                onColorChange={handleNodeColorChange}
                onAdd={handleAddClass}
                onCreateNew={handleCreateClass}
                canRemove={(n) => !isSystemClassUuid(n.uuid)}
                canAdd={(n) => !isBlockOnlyClass(n.uuid)}
              />
            </div>
            
            {/* Row 3: Tags */}
            <div className="page-header-section__tags">
              <NodePillRow
                nodes={pageTagDetails}
                searchMode="tags"
                emptyText="Add tag"
                searchPlaceholder="Search tags..."
                onNodeClick={(n) => handleNavigateToNode(n.id)}
                onRemove={handleRemoveTag}
                onColorChange={handleNodeColorChange}
                onAdd={handleAddTag}
                onCreateNew={handleCreateTag}
              />
            </div>
            
            {/* Row 4: Properties Section */}
            <div className="page-header-section__properties">
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
            
            {/* Cover Image - spans all rows */}
            <CoverImage
              pageId={node.id}
              coverImageId={coverImageId}
              onSelectImage={handleSelectCoverImage}
              onImageUploaded={handleCoverImageUploaded}
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
      

      
      {/* Class properties definition - only for class nodes (pages used as classes) */}
      {isClassNode && resolvedType === 'page' && (
        <ClassPropertiesEditor classNodeId={node.id} />
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
        <>
          {/* Properties Section for focused block */}
          <PropertiesSection 
            nodeId={node.id}
            variant="block"
            showHiddenSection={true}
            showAddProperty={true}
            onNavigateToNode={handleNavigateToNode}
            onOpenInSidebar={(id) => addSidebarCard(id, 'block')}
            defaultCollapsed={propertiesCollapsed}
          />
          <FocusedBlockContent
            node={node}
            onAddSidebarCard={(id) => addSidebarCard(id, 'block')}
          />
        </>
      )}
      
      {/* Show nodes that have this node as their class - only for class nodes */}
      {isClassNode && (
        <DynamicNodeViewSection
          nodeId={node.id}
          nodeUuid={node.uuid}
          viewType="classed_nodes"
          title="Nodes"
          icon={<TableIcon size="sm" />}
          hideWhenEmpty={false}
          defaultExpanded={true}
          onNodeClick={(targetNodeId) => openNode(targetNodeId, 'page')}
          onBlockCreated={(targetNodeId) => addSidebarCard(targetNodeId, 'block')}
        />
      )}
      
      {/* Child pages section - shows pages that have this node as parent (pages only) */}
      {resolvedType === 'page' && (
        <DynamicNodeViewSection
          nodeId={node.id}
          nodeUuid={node.uuid}
          viewType="child_pages"
          title="Children"
          icon={<PageIcon size="sm" />}
          hideWhenEmpty={true}
          defaultExpanded={true}
          onNodeClick={(targetNodeId) => openNode(targetNodeId, 'page')}
          onBlockCreated={(targetNodeId) => addSidebarCard(targetNodeId, 'block')}
        />
      )}
      
      {/* Extended By section - shows classes that extend this class (class nodes only) */}
      {isClassNode && (
        <ExtendedBySection 
          classNodeId={node.id}
          onNodeClick={(targetNodeId) => openNode(targetNodeId, 'page')}
          onAddSidebarCard={(id) => addSidebarCard(id, 'page')}
        />
      )}
      
      {/* Linked References - shows all references to this node (universal for all nodes) */}
      <DynamicNodeViewSection
        nodeId={node.id}
        nodeUuid={node.uuid}
        viewType="linked_references"
        title="Linked References"
        icon={<LinkIcon size="sm" />}
        defaultExpanded={!linkedRefsCollapsed}
        hideWhenEmpty={true}
        onNodeClick={(targetNodeId, isPage) => openNode(targetNodeId, isPage ? 'page' : 'block')}
        onBlockCreated={(targetNodeId) => addSidebarCard(targetNodeId, 'block')}
      />
      
      {/* Footer */}
      <footer className="node-view-footer">
        <div className="node-view-metadata">
          <span>Created: {formatDate(new Date(node.create_date), useSettingsStore.getState().dateFormat)}</span>
          <span>Updated: {formatDate(new Date(node.write_date), useSettingsStore.getState().dateFormat)}</span>
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

/**
 * Extended By Section - Shows classes that extend this class
 */
function ExtendedBySection({
  classNodeId,
  onNodeClick,
  onAddSidebarCard,
}: {
  classNodeId: number;
  onNodeClick: (nodeId: number) => void;
  onAddSidebarCard: (nodeId: number) => void;
}) {
  const { data: extendedByClasses, isLoading } = useExtendedByClasses(classNodeId);

  if (isLoading) return null;
  if (!extendedByClasses || extendedByClasses.length === 0) return null;

  // Convert to Node format for NodeCollection
  const nodes: Node[] = extendedByClasses.map(cls => ({
    id: cls.id,
    uuid: cls.uuid,
    name: cls.name,
    icon: cls.icon,
    color: null,
    parent_id: null,
    page_id: null,
    sequence: 0,
    collapsed: false,
    active: true,
    is_class: true,
    create_date: '',
    write_date: '',
  }));

  return (
    <NodeViewSection
      title="Extended By"
      icon={<TableIcon size="sm" />}
      count={nodes.length}
      defaultExpanded={true}
      hideWhenEmpty={true}
    >
      <NodeCollection
        nodes={nodes}
        viewMode="list"
        editable={false}
        onNodeClick={(node) => onNodeClick(node.id)}
        onNodeShiftClick={(node) => onAddSidebarCard(node.id)}
      />
    </NodeViewSection>
  );
}

export default NodeView;
