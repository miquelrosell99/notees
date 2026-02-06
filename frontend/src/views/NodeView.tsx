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
import React, { useState, useMemo, useCallback } from 'react';
import { useNode, useClasses, useNodesWithClass, useUpdateNode, useAddTag, useAddClass, useCreateNode, useProperties, useSetNodeProperty, useRemoveClass, useRemoveTag, useNodes, useTags, useContentSave, useLinkedReferencesCount, usePageClass, useClassExtends, useAddClassExtends, useRemoveClassExtends, useCreateProperty, useResolvedClassDetails } from '@/hooks';
import { useNodesStore, useBlockSelectionStore, useSettingsStore, formatDate } from '@/stores';
import { useKeyboardShortcut, SHORTCUT_IDS } from '@/hooks/useKeyboardShortcuts';
import type { Node, Property, PropertyCreate } from '@/types';
import type { ViewMode, NodeViewType } from '@/stores';

// Components
import { MainContentTopbar } from '../components/layout/MainContentTopbar';
import { PageHeader } from '../components/PageHeader';
import { NodeSelector } from '../components/NodeSelector';
import { ImageNode } from '../components/ImageNode';
import { AssetUploadModal } from '../components/assets/AssetUploadModal';
import { NodeContent } from '../components/nodes/NodeContent';
import { NodeCollection } from '../components/nodes/NodeCollection';
import { useBlockCallbacksFactory } from '../components/blocks/useBlockCallbacksFactory';
import { PageContextMenu, BlockContextMenu } from '../components/nodes/NodeContextMenu';
import { QuerySection } from '../components/nodes';
import { PropertiesSection } from '../components/PropertiesSection';
import { PropertySuggestionPopup } from '../components/properties/PropertySuggestionPopup';
import { ClassPropertiesEditor } from '../components/ClassPropertiesEditor';
import { Modal } from '../components/core/Modal';
import { TableIcon, PageIcon, LinkIcon } from '../components/icons';
import { Button } from '../components/core/Button';
import { mdiPlus, mdiChevronDown, mdiChevronLeft, mdiImageOutline, mdiTextBoxOutline, mdiFormatListBulleted, mdiWeatherNight, mdiViewGrid, mdiGraphOutline, mdiDockLeft, mdiDockRight, mdiDockTop, mdiCardOutline, mdiRestore } from '@mdi/js';
import Icon from '@mdi/react';
import { NodeBreadcrumbs } from '../components/nodes/NodeBreadcrumbs';
import { SelectionButton } from '../components/core/SelectionButton';

import { SYSTEM_PROPERTY_UUIDS, SYSTEM_CLASS_UUIDS, isNonRemovableClass, isBlockOnlyClass } from '@/constants';
import type { Asset } from '../api/assets';
import { extractImageFromDragEvent } from '@/hooks/useDragDropImage';
import { uploadAsset } from '@/api/assets';

import './NodeView.css';

// Local storage keys for collapse state
const BANNER_COLLAPSED_KEY = 'notees:banner-collapsed';
const COVER_COLLAPSED_KEY = 'notees:cover-collapsed';

/**
 * Get collapsed state for a specific node from localStorage
 */
function getCollapsedState(key: string, pageId: number, hasImage: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const states = JSON.parse(stored) as Record<string, boolean>;
      const storedState = states[pageId.toString()];
      if (storedState !== undefined) {
        return storedState;
      }
    }
  } catch {
    // Ignore parse errors
  }
  // Default: collapsed when empty, expanded when has image
  return !hasImage;
}

/**
 * Save collapsed state for a specific node to localStorage
 */
function setCollapsedState(key: string, pageId: number, collapsed: boolean): void {
  try {
    const stored = localStorage.getItem(key);
    const states = stored ? JSON.parse(stored) as Record<string, boolean> : {};
    states[pageId.toString()] = collapsed;
    localStorage.setItem(key, JSON.stringify(states));
  } catch {
    // Ignore storage errors
  }
}

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
  const { enterEditMode } = useBlockSelectionStore();
  const { handleNodeClick } = useNodeNavigation();
  
  // Debounced content save - batches rapid edits to reduce API calls
  const { handleContentChange } = useContentSave();

  // Handle shift+click (open in sidebar)
  const handleNodeShiftClick = useCallback((clickedNode: Node) => {
    onAddSidebarCard(clickedNode.id);
  }, [onAddSidebarCard]);

  // Handle add block (adds child to the focused block)
  const handleAddBlock = useCallback(async () => {
    // Compute next sequence from node's children
    const maxSequence = node.children?.reduce((max, child) => 
      Math.max(max, child.sequence ?? 0), -1) ?? -1;
    
    const newNode = await createNode.mutateAsync({
      name: '',
      parent_id: node.id,
      sequence: maxSequence + 1,
    });
    // Set the new block to edit mode so the user can start typing right away
    enterEditMode(newNode.id);
  }, [createNode, node.id, node.children, enterEditMode]);

  // Block callbacks for context provider
  const blockCallbacks = useBlockCallbacksFactory({
    onOpenBacklinks: (blockId) => onAddSidebarCard(blockId),
  });

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
        showClasses={true}
        provideBlockCallbacks={true}
        blockCallbacks={blockCallbacks}
        suppressRootColor={true}
      />
      <div className="focused-block-content-add">
        <Button icon={mdiPlus} onClick={handleAddBlock} className="add-block-btn" title="Add block" size="sm" variant="ghost">
          Add block
        </Button>
      </div>
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

export interface NodeViewResult {
  header: React.ReactNode;
  content: React.ReactNode;
}

export function NodeView({ nodeId, nodeType, viewMode, compactMode = false, propertiesCollapsed = false, linkedRefsCollapsed = false }: NodeViewProps): NodeViewResult {
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
  const setPropertyMutation = useSetNodeProperty();
  const createPropertyMutation = useCreateProperty();
  
  // Property popup state
  const [showPropertyPopup, setShowPropertyPopup] = useState(false);
  const selectedBlocksSet = useBlockSelectionStore(state => state.blockStates);
  const selectedBlocks = useMemo(() => 
    Array.from(selectedBlocksSet.entries())
      .filter(([_, state]) => state === 'selected')
      .map(([id]) => id),
    [selectedBlocksSet]
  );
  
  // Resolve page class details from IDs (excluding the implicit "page" class)
  // For system classes (like "day", "month", etc.), we show their "class" class but make it non-removable
  const pageClassDetails = useResolvedClassDetails(node?.classes);
  
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
  
  // Handle adding a class via NodeSelector
  const handleAddClass = useCallback((classNode: Node) => {
    if (!node) return;
    addClass.mutate({ nodeId: node.id, classId: classNode.id });
  }, [node, addClass]);
  
  // Handle creating a new class via NodeSelector
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
  
  // Handle removing a class via NodeSelector
  const handleRemoveClass = useCallback((classNode: Node) => {
    if (!node) return;
    removeClass.mutate({ nodeId: node.id, classId: classNode.id });
  }, [node, removeClass]);
  
  // Handle adding a tag via NodeSelector
  const handleAddTag = useCallback((tagNode: Node) => {
    if (!node) return;
    addTag.mutate({ nodeId: node.id, tagId: tagNode.id });
  }, [node, addTag]);
  
  // Handle creating a new tag via NodeSelector
  const handleCreateTag = useCallback((name: string) => {
    if (!node || !pageClassId) return;
    // Create as a page (tags are just pages linked to nodes)
    createNode.mutate({ name, classes: [pageClassId] }, {
      onSuccess: (newPage) => {
        addTag.mutate({ nodeId: node.id, tagId: newPage.id });
      }
    });
  }, [node, createNode, addTag, pageClassId]);
  
  // Handle removing a tag via NodeSelector
  const handleRemoveTag = useCallback((tagNode: Node) => {
    if (!node) return;
    removeTag.mutate({ nodeId: node.id, tagId: tagNode.id });
  }, [node, removeTag]);

  // Handler for selecting an existing property to add
  const handleSelectProperty = useCallback((property: Property) => {
    if (!node) return;
    // Determine target node: selected block or page
    const targetNodeId = selectedBlocks.length === 1 ? selectedBlocks[0] : node.id;
    
    // Set a default value based on property type
    let defaultValue: unknown;
    switch (property.type) {
      case 'boolean':
        defaultValue = false;
        break;
      case 'integer':
      case 'float':
        defaultValue = 0;
        break;
      case 'text':
      case 'selection':
        defaultValue = '';
        break;
      case 'node':
      case 'date':
      default:
        defaultValue = '';
        break;
    }
    setPropertyMutation.mutate({ nodeId: targetNodeId, propertyId: property.id, value: defaultValue });
    setShowPropertyPopup(false);
  }, [node, selectedBlocks, setPropertyMutation]);

  // Handler for creating a new property
  const handleCreateNewProperty = useCallback((data: PropertyCreate & { selection_options?: { name: string; icon?: string }[] }) => {
    if (!node) return;
    setShowPropertyPopup(false);
    const targetNodeId = selectedBlocks.length === 1 ? selectedBlocks[0] : node.id;
    
    createPropertyMutation.mutate(data, {
      onSuccess: async (newProperty) => {
        // Add the property to the target node with appropriate default value
        const defaultValue = newProperty.type === 'boolean' ? 'false' : '';
        setPropertyMutation.mutate({ nodeId: targetNodeId, propertyId: newProperty.id, value: defaultValue });
      },
    });
  }, [node, selectedBlocks, createPropertyMutation, setPropertyMutation]);

  // Handle keyboard shortcut Ctrl+Alt+P to add property
  useKeyboardShortcut(SHORTCUT_IDS.ADD_PROPERTY, () => {
    // Only open if on a node view (page or block)
    if (node) {
      setShowPropertyPopup(true);
    }
  });
  
  // Handle color change for class/tag nodes via NodeSelector
  const handleNodeColorChange = useCallback((targetNode: Node, color: string | null) => {
    updateNode.mutate({ id: targetNode.id, data: { color } });
  }, [updateNode]);

  // Handle adding an extends (inheritance) relationship
  const addClassExtends = useAddClassExtends();
  const handleAddExtends = useCallback((extendsClass: Node) => {
    if (!node) return;
    addClassExtends.mutate({ classId: node.id, extendsClassId: extendsClass.id });
  }, [node, addClassExtends]);

  // Handle creating a new class and adding it as extends
  const handleCreateExtends = useCallback((name: string) => {
    if (!node) return;
    const classClass = allClasses?.find(t => t.uuid === SYSTEM_CLASS_UUIDS.class);
    const pageClass = allClasses?.find(t => t.uuid === SYSTEM_CLASS_UUIDS.page);
    
    // Create with Page and Class classes
    const classes = [];
    if (pageClass) classes.push(pageClass.id);
    if (classClass) classes.push(classClass.id);
    
    createNode.mutate({ name, classes }, {
      onSuccess: (newClass) => {
        addClassExtends.mutate({ classId: node.id, extendsClassId: newClass.id });
      }
    });
  }, [node, createNode, addClassExtends, allClasses]);

  // Handle removing an extends relationship
  const removeClassExtends = useRemoveClassExtends();
  const handleRemoveExtends = useCallback((extendsClass: Node) => {
    if (!node) return;
    removeClassExtends.mutate({ classId: node.id, extendsClassId: extendsClass.id });
  }, [node, removeClassExtends]);

  // Fetch class extends (inheritance) data for classes
  const { data: extendsData } = useClassExtends(node?.is_class ? node.id : null);

  // Resolve extends details from IDs
  const extendsDetails = useMemo(() => {
    if (!extendsData || extendsData.length === 0) return [];
    return extendsData
      .map(ext => {
        return allNodes?.find(n => n.id === ext.extends_class_node_id);
      })
      .filter((n): n is Node => n !== undefined);
  }, [extendsData, allNodes]);
  
  // Check if node is used as a class
  const { data: classedNodes } = useNodesWithClass(node?.id ?? 0);
  
  // Section metadata hooks
  useLinkedReferencesCount(nodeId);
  
  // Context menu state
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  
  // Cover image picker state
  const [isCoverImagePickerOpen, setIsCoverImagePickerOpen] = useState(false);
  
  // Banner and cover collapse/drag states
  const [isBannerCollapsed, setIsBannerCollapsed] = useState(true);
  const [isCoverCollapsed, setIsCoverCollapsed] = useState(true);
  const [isBannerDragging, setIsBannerDragging] = useState(false);
  const [isCoverDragging, setIsCoverDragging] = useState(false);
  const [isBannerHovered, setIsBannerHovered] = useState(false);
  const [isCoverHovered, setIsCoverHovered] = useState(false);
  
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
    if (!coverProperty?.id) return null;
    const coverValue = node?.properties?.[coverProperty.id];
    return typeof coverValue === 'number' ? coverValue : null;
  }, [node?.properties, coverProperty?.id]);
  
  // Find the banner property by UUID
  const bannerProperty = useMemo(() => {
    return allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.banner);
  }, [allProperties]);
  
  // Get banner image ID from properties
  const bannerImageId = useMemo(() => {
    if (!bannerProperty?.id) return null;
    const bannerValue = node?.properties?.[bannerProperty.id];
    return typeof bannerValue === 'number' ? bannerValue : null;
  }, [node?.properties, bannerProperty?.id]);
  
  // Initialize and persist collapse states
  React.useEffect(() => {
    if (node?.id) {
      setIsBannerCollapsed(getCollapsedState(BANNER_COLLAPSED_KEY, node.id, !!bannerImageId));
      setIsCoverCollapsed(getCollapsedState(COVER_COLLAPSED_KEY, node.id, !!coverImageId));
    }
  }, [node?.id, bannerImageId, coverImageId]);
  
  // Collapse handlers
  const handleToggleBannerCollapse = useCallback(() => {
    if (!node) return;
    setIsBannerCollapsed(prev => {
      const newState = !prev;
      setCollapsedState(BANNER_COLLAPSED_KEY, node.id, newState);
      return newState;
    });
  }, [node]);
  
  const handleToggleCoverCollapse = useCallback(() => {
    if (!node) return;
    setIsCoverCollapsed(prev => {
      const newState = !prev;
      setCollapsedState(COVER_COLLAPSED_KEY, node.id, newState);
      return newState;
    });
  }, [node]);
  
  // Banner remove handler
  const handleRemoveBanner = useCallback(() => {
    if (!bannerProperty || !node) return;
    setPropertyMutation.mutate({
      nodeId: node.id,
      propertyId: bannerProperty.id,
      value: null
    });
  }, [node, bannerProperty, setPropertyMutation]);
  
  // Cover remove handler
  const handleRemoveCover = useCallback(() => {
    if (!coverProperty || !node) return;
    setPropertyMutation.mutate({
      nodeId: node.id,
      propertyId: coverProperty.id,
      value: null
    });
  }, [node, coverProperty, setPropertyMutation]);
  
  // Banner drag handlers
  const handleBannerDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsBannerDragging(true);
  }, []);
  
  const handleBannerDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsBannerDragging(false);
  }, []);
  
  const handleBannerDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsBannerDragging(false);
    
    if (!bannerProperty || !node) return;
    
    try {
      const result = await extractImageFromDragEvent(e);
      if (result) {
        const asset = await uploadAsset(result.file);
        setPropertyMutation.mutate({
          nodeId: node.id,
          propertyId: bannerProperty.id,
          value: asset.node_id
        });
        if (isBannerCollapsed) {
          setIsBannerCollapsed(false);
          setCollapsedState(BANNER_COLLAPSED_KEY, node.id, false);
        }
      }
    } catch (error) {
      console.error('Failed to upload dropped banner:', error);
    }
  }, [bannerProperty, node, setPropertyMutation, isBannerCollapsed]);
  
  // Cover drag handlers
  const handleCoverDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsCoverDragging(true);
  }, []);
  
  const handleCoverDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsCoverDragging(false);
  }, []);
  
  const handleCoverDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsCoverDragging(false);
    
    if (!coverProperty || !node) return;
    
    try {
      const result = await extractImageFromDragEvent(e);
      if (result) {
        const asset = await uploadAsset(result.file);
        setPropertyMutation.mutate({
          nodeId: node.id,
          propertyId: coverProperty.id,
          value: asset.node_id
        });
        if (isCoverCollapsed) {
          setIsCoverCollapsed(false);
          setCollapsedState(COVER_COLLAPSED_KEY, node.id, false);
        }
      }
    } catch (error) {
      console.error('Failed to upload dropped cover:', error);
    }
  }, [coverProperty, node, setPropertyMutation, isCoverCollapsed]);
  
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
    return {
      header: <MainContentTopbar />,
      content: (
        <article className={`node-view node-view--loading ${viewMode}`}>
          <div className="loading-state">Loading...</div>
        </article>
      )
    };
  }
  
  // Error state
  if (error || !node) {
    return {
      header: <MainContentTopbar />,
      content: (
        <article className={`node-view node-view--error ${viewMode}`}>
          <div className="error-state">Node not found</div>
        </article>
      )
    };
  }

  // Build header content
  const headerContent = (
    <MainContentTopbar
      left={
        <NodeBreadcrumbs
          nodeId={nodeId}
          nodeType={resolvedType}
          onNavigate={(id, type) => openNode(id, type)}
          propertyContext={undefined}
          className="node-view-breadcrumbs"
        />
      }
      right={
        <div className="node-view-controls">
          {/* Document/Bullet/Card mode selector - only for pages, not blocks */}
          {resolvedType !== 'block' && (
            <SelectionButton
              options={[
                { value: 'bullet', icon: mdiFormatListBulleted, label: 'Bullet mode' },
                { value: 'document', icon: mdiTextBoxOutline, label: 'Document mode' },
                { value: 'card', icon: mdiViewGrid, label: 'Card mode' },
              ]}
              value={contentDisplayMode}
              onChange={(val) => useNodesStore.getState().setContentDisplayMode(val as 'bullet' | 'document' | 'card')}
              size="sm"
            />
          )}
          
          {/* Card layout selector - only visible in card mode for pages */}
          {resolvedType !== 'block' && contentDisplayMode === 'card' && (
            <div className="card-layout-selector">
              <Button 
                variant="ghost"
                size="sm"
                icon={mdiCardOutline}
                className={`card-layout-option ${useNodesStore.getState().cardLayout === 'no-cover' ? 'card-layout-option--active' : ''}`}
                onClick={() => useNodesStore.getState().setCardLayout('no-cover')}
                title="No cover"
              />
              <Button 
                variant="ghost"
                size="sm"
                icon={mdiDockLeft}
                className={`card-layout-option ${useNodesStore.getState().cardLayout === 'cover-left' ? 'card-layout-option--active' : ''}`}
                onClick={() => useNodesStore.getState().setCardLayout('cover-left')}
                title="Cover left"
              />
              <Button 
                variant="ghost"
                size="sm"
                icon={mdiDockRight}
                className={`card-layout-option ${useNodesStore.getState().cardLayout === 'cover-right' ? 'card-layout-option--active' : ''}`}
                onClick={() => useNodesStore.getState().setCardLayout('cover-right')}
                title="Cover right"
              />
              <Button 
                variant="ghost"
                size="sm"
                icon={mdiDockTop}
                className={`card-layout-option ${useNodesStore.getState().cardLayout === 'cover-top' ? 'card-layout-option--active' : ''}`}
                onClick={() => useNodesStore.getState().setCardLayout('cover-top')}
                title="Cover top"
              />
            </div>
          )}
          
          {/* Late night thoughts filter */}
          <Button
            icon={mdiWeatherNight}
            variant="ghost"
            size="sm"
            onClick={useNodesStore.getState().toggleLateNightThoughts}
            active={lateNightThoughtsFilter}
            aria-label="Toggle late night thoughts"
            title="Show only late night thoughts (created 10PM-4AM)"
            className="toolbar-btn"
          />
          
          {/* Local graph button */}
          <Button
            icon={mdiGraphOutline}
            variant="ghost"
            size="sm"
            active={useNodesStore.getState().rightSidebarContent === 'localGraph'}
            onClick={() => useNodesStore.getState().openLocalGraph(nodeId)}
            aria-label="Local graph"
            title="Show local graph for this node"
            className="toolbar-btn"
          />
          
          {/* Reset all views button */}
          <Button
            icon={mdiRestore}
            variant="ghost"
            size="sm"
            onClick={async () => {
              try {
                const { useResetNodeViews } = await import('@/hooks/useNodeViews');
                await useResetNodeViews().mutateAsync(nodeId);
              } catch (error) {
                console.error('Failed to reset views:', error);
              }
            }}
            aria-label="Reset all views"
            title="Reset all views to defaults"
            className="toolbar-btn"
          />
        </div>
      }
    />
  );

  // Build main content
  const mainContent = (
    <article 
      className={`node-view node-view--${resolvedType} ${viewMode}`}
    >
      {/* Page Header or Block Header based on variant */}
      {resolvedType === 'page' ? (
        <>
          {/* Banner Image - before entire header section */}
          <div 
            className={`node-view__banner ${isBannerDragging ? 'node-view__banner--dragging' : ''}`}
            onMouseEnter={() => setIsBannerHovered(true)}
            onMouseLeave={() => setIsBannerHovered(false)}
          >
            <button
              className="node-view__banner-collapse-btn"
              onClick={handleToggleBannerCollapse}
              title={isBannerCollapsed ? "Expand banner image" : "Collapse banner"}
              aria-label={isBannerCollapsed ? "Expand banner image" : "Collapse banner image"}
              aria-expanded={!isBannerCollapsed}
            >
              <Icon path={mdiChevronDown} size={0.7} rotate={isBannerCollapsed ? 0 : 180} />
            </button>
            
            <div 
              className={`node-view__banner-content ${isBannerCollapsed ? 'node-view__banner-content--collapsed' : 'node-view__banner-content--expanded'}`}
              onDragOver={handleBannerDragOver}
              onDragLeave={handleBannerDragLeave}
              onDrop={handleBannerDrop}
            >
              {bannerImageId ? (
                <ImageNode
                  assetNodeId={bannerImageId}
                  alt="Banner"
                  className="node-view__banner-image"
                  showCard={true}
                  elevation="low"
                  radius="md"
                  clickable={true}
                  showActions={isBannerHovered && !isBannerCollapsed}
                  onEdit={handleSelectBannerImage}
                  onRemove={handleRemoveBanner}
                  actionsDirection="horizontal"
                  isDragging={isBannerDragging}
                  showModalBullet={true}
                />
              ) : (
                <Button 
                  variant="ghost"
                  size="sm"
                  className="node-view__banner-add-btn"
                  onClick={handleSelectBannerImage}
                  title="Add banner image"
                >
                  <Icon path={mdiImageOutline} size={0.8} />
                  <span>Add banner</span>
                </Button>
              )}
            </div>
          </div>
          
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
            
            {/* Row 2: Classes and Tags stacked */}
            <div className="page-header-section__types-and-tags">
              <div className="page-header-section__types">
                <NodeSelector
                  nodes={pageClassDetails}
                  searchMode="classes"
                  emptyText="Add class"
                  searchPlaceholder="Search classes..."
                  onNodeClick={(n) => handleNavigateToNode(n.id)}
                  onRemove={handleRemoveClass}
                  onColorChange={handleNodeColorChange}
                  onAdd={handleAddClass}
                  onCreateNew={handleCreateClass}
                  canRemove={(n) => !isNonRemovableClass(n.uuid)}
                  canAdd={(n) => !isBlockOnlyClass(n.uuid)}
                />
              </div>
              
              <div className="page-header-section__tags">
                <div className="section-label">Tags:</div>
                <NodeSelector
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
            </div>
            
            {/* Row 3: Extends (only for classes) */}
            {node.is_class && (
              <div className="page-header-section__extends">
                <div className="section-label">Extends:</div>
                <NodeSelector
                  nodes={extendsDetails}
                  searchMode="classes"
                  emptyText="Add extend"
                  searchPlaceholder="Search classes to extend..."
                  onNodeClick={(n) => handleNavigateToNode(n.id)}
                  onRemove={handleRemoveExtends}
                  onColorChange={handleNodeColorChange}
                  onAdd={handleAddExtends}
                  onCreateNew={handleCreateExtends}
                />
              </div>
            )}
            
            {/* Cover Image - spans rows 1-3 */}
            <div 
              className={`node-view__cover ${isCoverDragging ? 'node-view__cover--dragging' : ''}`}
              onMouseEnter={() => setIsCoverHovered(true)}
              onMouseLeave={() => setIsCoverHovered(false)}
            >
              <button
                className="node-view__cover-collapse-btn"
                onClick={handleToggleCoverCollapse}
                title={isCoverCollapsed ? "Expand cover image" : "Collapse cover"}
                aria-label={isCoverCollapsed ? "Expand cover image" : "Collapse cover image"}
                aria-expanded={!isCoverCollapsed}
              >
                <Icon path={mdiChevronLeft} size={0.7} rotate={isCoverCollapsed ? 0 : 180} />
              </button>
              
              <div 
                className={`node-view__cover-content ${isCoverCollapsed ? 'node-view__cover-content--collapsed' : 'node-view__cover-content--expanded'}`}
                onDragOver={handleCoverDragOver}
                onDragLeave={handleCoverDragLeave}
                onDrop={handleCoverDrop}
              >
                {coverImageId ? (
                  <ImageNode
                    assetNodeId={coverImageId}
                    alt="Cover"
                    className="node-view__cover-image"
                    showCard={true}
                    elevation="low"
                    radius="md"
                    clickable={true}
                    showActions={isCoverHovered && !isCoverCollapsed}
                    onEdit={handleSelectCoverImage}
                    onRemove={handleRemoveCover}
                    actionsDirection="vertical"
                    isDragging={isCoverDragging}
                    showModalBullet={true}
                  />
                ) : (
                  <button
                    className="node-view__cover-add-btn"
                    onClick={handleSelectCoverImage}
                    title="Add cover image"
                  >
                    <Icon path={mdiImageOutline} size={0.8} />
                  </button>
                )}
              </div>
            </div>
          </div>
          
          {/* Properties Section - full width row below header section */}
          <div className="page-properties-section">
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
      
      {/* Extended By section - shows classes that extend this class (class nodes only) */}
      {isClassNode && (
        <QuerySection
          nodeId={node.id}
          nodeUuid={node.uuid}
          viewType="extended_by"
          title="Extended By"
          icon={<TableIcon size="sm" />}
          hideWhenEmpty={true}
          defaultExpanded={true}
          onNodeClick={(targetNodeId) => openNode(targetNodeId, 'page')}
          onBlockCreated={(targetNodeId) => addSidebarCard(targetNodeId, 'block')}
          hideViewManagement={true}
          can_create={false}
          showClasses={false}
        />
      )}

      {/* Show nodes that have this node as their class - only for class nodes */}
      {isClassNode && (
        <QuerySection
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
        <QuerySection
          nodeId={node.id}
          nodeUuid={node.uuid}
          viewType="child_pages"
          title="Children"
          icon={<PageIcon size="sm" />}
          hideWhenEmpty={true}
          defaultExpanded={true}
          onNodeClick={(targetNodeId) => openNode(targetNodeId, 'page')}
          onBlockCreated={(targetNodeId) => addSidebarCard(targetNodeId, 'block')}
          hideViewManagement={true}
        />
      )}
      
      {/* Linked References - shows all references to this node (universal for all nodes) */}
      <QuerySection
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

      {/* Property Suggestion Modal for Ctrl+Alt+P */}
      {showPropertyPopup && (
        <Modal
          isOpen={showPropertyPopup}
          onClose={() => setShowPropertyPopup(false)}
          title="Add Property"
          size="sm"
        >
          <PropertySuggestionPopup
            isOpen={showPropertyPopup}
            onClose={() => setShowPropertyPopup(false)}
            onSelect={handleSelectProperty}
            onCreate={handleCreateNewProperty}
            excludeIds={[]}
          />
        </Modal>
      )}
    </article>
  );

  return {
    header: headerContent,
    content: mainContent
  };
}

/**
 * NodeViewWrapper - React component wrapper for NodeView function
 * Renders header as fixed bar and content in scrollable area
 */
export function NodeViewWrapper(props: NodeViewProps) {
  const { header, content } = NodeView(props);
  return header;
}

/**
 * NodeViewContent - Renders just the content portion
 */
export function NodeViewContent(props: NodeViewProps) {
  const { content } = NodeView(props);
  return content;
}

export default NodeView;

