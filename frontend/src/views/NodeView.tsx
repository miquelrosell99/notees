/**
 * NodeView Component - Unified view for pages and blocks
 * 
 * Main component for displaying nodes with two variants:
 * - Page variant: Shows PageHeader, NodeContent with children, and sections
 * - Block variant: Shows the focused block as a top-level list item using NodeCollection
 *                  (list, document, and card view modes are available)
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
import React, { useState, useMemo, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNode, useClasses, useNodesWithClass, useUpdateNode, useAddTag, useAddClass, useCreateNode, useProperties, useSetNodeProperty, useRemoveClass, useRemoveTag, useTags, useContentSave, useLinkedReferencesCount, usePageClass, useClassExtends, useAddClassExtends, useRemoveClassExtends, useCreateProperty, useResolvedClassDetails, useNodeNavigation, useAddAlias, useRemoveAlias, useLivePageSync, useWorkspaceRole, nodeNameToText } from '@/hooks';
import { useIsMobile } from '@/hooks/useIsMobile';
import { nodeKeys } from '@/hooks/queryKeys';
import * as nodesApi from '@/api/nodes';
import { useNavigationStore, useAppStore, useSettingsStore, formatDate } from '@/stores';
import { useFindReplaceStore } from '@/stores/findReplaceStore';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';
import { useCommand } from '@/hooks/useCommand';
import { SHORTCUT_IDS } from '@/stores/keyboardStore';
import { COMMAND_IDS } from '@/stores/commandRegistry';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { useBlockPersist } from '@/hooks/useBlockPersist';
import { generateUUID } from '@/utils/uuid';
import type { Node, Property, PropertyCreate } from '@/types';
import type { ViewMode, NodeViewType } from '@/stores';

// Components
import { MainContentTopbar } from '../components/layout/MainContentTopbar';
import { PageHeader } from '../components/nodes/PageHeader';
import { ImageNode } from '../components/nodes/ImageNode';
import { AssetUploadModal } from '../components/assets/AssetUploadModal';
import { NodeContent } from '../components/nodes/NodeContent';
import { NodeCollection } from '../components/nodes/NodeCollection';

import { PageContextMenu, BlockContextMenu } from '../components/nodes/NodeContextMenu';
import { QuerySection, NodeActivityLogSection } from '../components/nodes';
import { PropertiesSection } from '../components/properties/PropertiesSection';
import { PropertySuggestionPopup } from '../components/properties/PropertySuggestionPopup';
import { ClassPropertiesEditor } from '../components/properties/ClassPropertiesEditor';
import { NodeMetadataSection } from '../components/nodes/NodeMetadataSection';
import { Modal } from '../components/core/Modal';
import { TableIcon, PageIcon, LinkIcon, SearchIcon } from '../components/core/icons';
import { Button } from '../components/core/Button';
import { BlockPresenceOverlay } from '../components/collab/BlockPresenceOverlay';

import { NodeBreadcrumbs } from '../components/nodes/NodeBreadcrumbs';
import { SelectionButton } from '../components/core/SelectionButton';

import { SYSTEM_PROPERTY_UUIDS, SYSTEM_CLASS_UUIDS, isNonRemovableClass, isBlockOnlyClass } from '@/constants';
import { buildScheduledForDayQueryAST, buildOverdueQueryAST } from '@/utils/taskQueries';
import { isDayUuid, getTodayDayUuid } from '@/utils/dateUuid';
import { ReferencedNodesProvider } from '@/contexts/ReferencedNodesProvider';
import type { Asset } from '../api/assets';
import { extractImageFromDragEvent } from '@/hooks/useDragDropImage';
import { uploadAsset } from '@/api/assets';
import { getOrCreateDaily } from '@/api/nodes';

import './NodeView.css';
import { Icon } from '@/components/core/icons';

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
 * FocusedBlockContent - Renders a focused block as a top-level list item
 * 
 * Used when viewing a single block (not a page). The block itself is rendered
 * as the first item in a list view, with its children nested below it.
 * Supports list and card view modes.
 */
interface FocusedBlockContentProps {
  node: Node;
  onAddSidebarCard: (nodeId: number) => void;
  displayMode?: 'bullet' | 'document' | 'card';
  editable?: boolean;
  canCreate?: boolean;
}

function FocusedBlockContent({ node, onAddSidebarCard, displayMode = 'bullet', editable = true, canCreate = true }: FocusedBlockContentProps) {
  const { handleNodeClick } = useNodeNavigation();
  
  // Debounced content save - batches rapid edits to reduce API calls
  const { handleContentChange } = useContentSave();

  const addClass = useAddClass();

  // Handle shift+click (open in sidebar)
  const handleNodeShiftClick = useCallback((clickedNode: Node) => {
    onAddSidebarCard(clickedNode.id);
  }, [onAddSidebarCard]);

  const handleAddClass = useCallback((blockId: number, classId: number) => {
    // Optimistically update the runtime for immediate visual feedback
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getAllNodes().find(n => n.serverId === blockId);
    if (graphNode) {
      const classStrId = String(classId);
      if (!graphNode.classIds.includes(classStrId)) {
        runtime.upsertNodes([{
          ...graphNode,
          classIds: [...graphNode.classIds, classStrId],
        }]);
      }
    }
    addClass.mutate({ nodeId: blockId, classId });
  }, [addClass]);

  // Ensure blocks created via the Add Block button get persisted even when
  // no BlockEditor (which normally hosts useBlockPersist) is mounted yet.
  useBlockPersist();

  // Register page-level keyboard commands
  useCommand(COMMAND_IDS.FIND, () => {
    useFindReplaceStore.getState().open();
  }, { label: 'Find in Page' });

  useCommand(COMMAND_IDS.FIND_TOGGLE_REPLACE, () => {
    const state = useFindReplaceStore.getState();
    if (state.isOpen) {
      state.toggleReplaceExpanded();
    } else {
      state.open();
      state.toggleReplaceExpanded();
    }
  }, { label: 'Toggle Replace' });

  // Handle add block (adds child to the focused block)
  const handleAddBlock = useCallback(() => {
    console.log('[NodeView/FocusedBlock] handleAddBlock triggered', { nodeUuid: node.uuid, childrenCount: node.children?.length });
    // Create via runtime intent so the block appears immediately (no API roundtrip)
    // and useBlockPersist handles persistence automatically.
    const runtime = getNodeGraphRuntime();
    const newBlockId = generateUUID();

    // Register the parent's serverId so useBlockPersist can resolve it
    runtime.registerParentServerId(node.uuid, node.id);

    const nodeChildren = node.children ?? [];
    // The API orders children by sequence, so the last array element is the rightmost block.
    const lastChild = nodeChildren.length > 0 ? nodeChildren[nodeChildren.length - 1] : null;

    console.log('[NodeView/FocusedBlock] Applying create_block intent', { newBlockId, parentId: node.uuid, afterBlockId: lastChild?.uuid ?? null });
    runtime.requestFocus(newBlockId);
    runtime.applyIntent({
      type: 'create_block',
      parentId: node.uuid,
      afterBlockId: lastChild?.uuid ?? null,
      blockId: newBlockId,
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
    });
    runtime.flushEvents();
  }, [node.uuid, node.id, node.children]);

  // In card mode, show the focused block as a bullet header (depth 0 only),
  // then its children separately as cards.
  // In list mode, the single NodeCollection handles both the block and children.
  // Document mode is not supported for focused blocks; treat it as list.
  const isCardMode = displayMode === 'card';

  if (isCardMode) {
    return (
      <div className="focused-block-content">
        {/* The focused block itself — always shown as a bullet */}
        <NodeCollection
          key="focused-block-bullet"
          nodes={[node]}
          viewMode="list"
          availableViewModes={['list']}
          editable={editable}
          onNodeClick={handleNodeClick}
          onNodeShiftClick={handleNodeShiftClick}
          onContentChange={handleContentChange}
          showClasses={true}
          pageId={node.id}
          nodeUuid={node.uuid}
          maxDepth={0}
          onAddClass={handleAddClass}
        />
        {/* Children shown as cards */}
        <NodeCollection
          nodes={node.children ?? []}
          viewMode="card"
          availableViewModes={['list', 'card']}
          editable={editable}
          onNodeClick={handleNodeClick}
          onNodeShiftClick={handleNodeShiftClick}
          onContentChange={handleContentChange}
          showClasses={true}
          pageId={node.id}
          nodeUuid={node.uuid}
          onAddClass={handleAddClass}
        />
        <div className="focused-block-content-add">
          {canCreate && (
            <Button icon={"mdi mdi-plus"} onClick={handleAddBlock} className="add-block-btn" title="Add block" size="sm" variant="ghost">
              Add block
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="focused-block-content">
      <NodeCollection
        key="focused-block-list"
        nodes={[node]}
        viewMode="list"
        availableViewModes={['list', 'card']}
        editable={editable}
        onNodeClick={handleNodeClick}
        onNodeShiftClick={handleNodeShiftClick}
        onContentChange={handleContentChange}
        showClasses={true}
        pageId={node.id}
        nodeUuid={node.uuid}
        onAddClass={handleAddClass}
      />
      <div className="focused-block-content-add">
        {canCreate && (
          <Button icon={"mdi mdi-plus"} onClick={handleAddBlock} className="add-block-btn" title="Add block" size="sm" variant="ghost">
            Add block
          </Button>
        )}
      </div>
    </div>
  );
}

interface NodeViewProps {
  /** Node ID to display */
  nodeId: number;

  /** View mode (document, etc.) */
  viewMode: ViewMode;
  /** If true, hides banner and page header section but keeps properties and queries (for sidebar cards) */
  sidebarMode?: boolean;
  
  // Granular section visibility controls (override sidebarMode defaults)
  /** If true, hides the banner image section */
  hideBanner?: boolean;
  /** If true, hides the page header section (title, icon, classes, tags, aliases, cover) */
  hidePageHeader?: boolean;
  /** If true, hides the properties section */
  hideProperties?: boolean;
  /** If true, hides all query sections (linked refs, unlinked refs, etc.) */
  hideQueries?: boolean;
  /** If true, hides the footer */
  hideFooter?: boolean;
  
  /** Whether the properties section is collapsed by default */
  propertiesCollapsed?: boolean;
  /** Whether the linked references section is collapsed by default */
  linkedRefsCollapsed?: boolean;
}

export interface NodeViewResult {
  header: React.ReactNode;
  content: React.ReactNode;
}

/**
 * Counts words across a node and all its children recursively
 */
function countWordsInTree(node: Node, isRoot = true): { words: number; blocks: number } {
  let words = 0;
  let blocks = 0;
  
  const skipSelf = isRoot && node.is_page;
  if (!skipSelf) {
    const text = nodeNameToText(node.name);
    if (text) {
      words += text.split(/\s+/).filter(w => w.length > 0).length;
    }
    blocks++;
  }
  
  if (node.children) {
    for (const child of node.children) {
      const childCounts = countWordsInTree(child, false);
      words += childCounts.words;
      blocks += childCounts.blocks;
    }
  }
  
  return { words, blocks };
}

function WordCount({ node }: { node: Node }) {
  const { words, blocks } = useMemo(() => countWordsInTree(node), [node]);
  
  return (
    <div className="node-view-word-count">
      <span>{words.toLocaleString()} words</span>
      <span>{blocks.toLocaleString()} blocks</span>
    </div>
  );
}

export function NodeView({ 
  nodeId, 
  viewMode, 
  sidebarMode = false,
  hideBanner,
  hidePageHeader,
  hideProperties,
  hideQueries,
  hideFooter,
  propertiesCollapsed = false, 
  linkedRefsCollapsed = false 
}: NodeViewProps): NodeViewResult {
  // Compute section visibility from mode flags and explicit overrides
  const showBanner = hideBanner !== undefined ? !hideBanner : !sidebarMode;
  const showPageHeader = hidePageHeader !== undefined ? !hidePageHeader : !sidebarMode;
  const showProperties = hideProperties !== undefined ? !hideProperties : true;
  const showQueries = hideQueries !== undefined ? !hideQueries : true;
  const showFooter = hideFooter !== undefined ? !hideFooter : !sidebarMode;
  
  // Fetch the node — include properties/backlinks if we're showing properties or queries
  const { data: node, isLoading, error } = useNode(nodeId, { 
    include_children: true, 
    include_properties: showProperties || showQueries,
    include_backlinks: showProperties || showQueries
  });
  
  // Hooks (needed for page header sections)
  const { data: allClasses } = useClasses();
  const { data: allTags } = useTags();
  const { data: aliasedNodeData } = useNode(node?.aliased_id ?? null);
  const { data: allProperties } = useProperties();
  const { pageClassId } = usePageClass();
  const { addSidebarCard, openNode } = useNavigationStore();
  const { contentDisplayMode } = useAppStore();
  const isMobile = useIsMobile();
  const { canWrite: workspaceCanWrite, canCreate: workspaceCanCreate, isOwner } = useWorkspaceRole();
  const { navigateToNode } = useNodeNavigation();
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
  // When set, the property popup targets a specific block; otherwise the current node
  const [propertyTargetNodeId, setPropertyTargetNodeId] = useState<number | null>(null);
  
  const navigateToDay = useCallback(async (dateStr: string) => {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return;
    const formatted = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    try {
      const dailyNode = await getOrCreateDaily(formatted);
      openNode(dailyNode.id);
    } catch (error) {
      console.error('Failed to open daily page:', error);
    }
  }, [openNode]);
  
  // Resolve page class details from IDs (excluding the implicit "page" class)
  // For system classes (like "day", "month", etc.), we show their "class" class but make it non-removable
  // For aliases, inherit classes from the aliased (main) node
  const isAlias = !!node?.aliased_id;
  const aliasedNode = useMemo(() => {
    if (!isAlias || !node?.aliased_id) return null;
    return aliasedNodeData ?? null;
  }, [isAlias, node?.aliased_id, aliasedNodeData]);
  const effectiveClasses = isAlias ? (aliasedNode?.classes ?? []) : node?.classes;
  const pageClassDetails = useResolvedClassDetails(effectiveClasses);
  
  // Resolve page tag details from IDs (excluding class definitions)
  const pageTagDetails = useMemo(() => {
    if (!node?.tags || node.tags.length === 0) return [];
    return node.tags
      .map(tagId => allTags?.find(t => t.id === tagId))
      .filter((t): t is Node => {
        if (t === undefined) return false;
        // Hide class definitions (they shouldn't show as tags)
        if (t.is_class) return false;
        return true;
      });
  }, [node?.tags, allTags]);
  
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

  // Handle converting an existing page to a class by adding the "class" class to it
  const handleConvertToClass = useCallback((pageNode: Node) => {
    if (!node) return;
    const classClass = allClasses?.find(t => t.uuid === SYSTEM_CLASS_UUIDS.class);
    if (!classClass) return;
    // Add the "class" class to the target page, then add it to the current node
    addClass.mutate({ nodeId: pageNode.id, classId: classClass.id }, {
      onSuccess: () => {
        addClass.mutate({ nodeId: node.id, classId: pageNode.id });
      }
    });
  }, [node, addClass, allClasses]);
  
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

  // ---- Alias support ----
  const addAlias = useAddAlias();
  const removeAlias = useRemoveAlias();
  
  // Fetch alias nodes directly (allNodes excludes aliased pages)
  const { data: pageAliasDetails = [] } = useQuery({
    queryKey: nodeKeys.aliases(nodeId ?? 0),
    queryFn: () => nodesApi.getAliases(nodeId!),
    enabled: !!nodeId && !!node?.aliases && node.aliases.length > 0,
  });
  
  // Handle adding an alias via NodeSelector
  const handleAddAlias = useCallback((aliasNode: Node) => {
    if (!node) return;
    addAlias.mutate({ nodeId: node.id, aliasNodeId: aliasNode.id });
  }, [node, addAlias]);
  
  // Handle removing an alias via NodeSelector
  const handleRemoveAlias = useCallback((aliasNode: Node) => {
    if (!node) return;
    removeAlias.mutate({ nodeId: node.id, aliasId: aliasNode.id });
  }, [node, removeAlias]);

  // Register toggle-private command for command palette
  const togglePrivate = useCallback(() => {
    if (!node || !isOwner) return;
    updateNode.mutate({ id: node.id, data: { is_private: !node.is_private } });
  }, [node, isOwner, updateNode]);

  useCommand(
    COMMAND_IDS.TOGGLE_PRIVATE,
    togglePrivate,
    {
      label: node?.is_private ? 'Make page public' : 'Make page private',
      icon: 'lock',
      requiresPage: true,
      enabled: !!node && node.is_page && !!isOwner,
    }
  );
  
  const handleNavigateToNode = useCallback((id: number) => {
    openNode(id);
  }, [openNode]);

  // Handle navigating to an alias node (skip redirection to show the alias itself)
  const handleNavigateToAlias = useCallback((aliasNode: Node) => {
    navigateToNode(aliasNode, { skipAliasRedirect: true });
  }, [navigateToNode]);

  // Handler for selecting an existing property to add
  const handleSelectProperty = useCallback((property: Property) => {
    if (!node) return;
    const targetNodeId = propertyTargetNodeId ?? node.id;
    
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
    setPropertyTargetNodeId(null);
  }, [node, propertyTargetNodeId, setPropertyMutation]);

  // Handler for creating a new property
  const handleCreateNewProperty = useCallback((data: PropertyCreate & { selection_options?: { name: string; icon?: string }[] }) => {
    if (!node) return;
    setShowPropertyPopup(false);
    const targetNodeId = propertyTargetNodeId ?? node.id;
    setPropertyTargetNodeId(null);
    
    createPropertyMutation.mutate(data, {
      onSuccess: async (newProperty) => {
        // Add the property to the target node with appropriate default value
        const defaultValue = newProperty.type === 'boolean' ? 'false' : '';
        setPropertyMutation.mutate({ nodeId: targetNodeId, propertyId: newProperty.id, value: defaultValue });
      },
    });
  }, [node, propertyTargetNodeId, createPropertyMutation, setPropertyMutation]);

  // Handle keyboard shortcut Ctrl+Alt+P to add property
  useKeyboardShortcut(SHORTCUT_IDS.ADD_PROPERTY, () => {
    if (!node) return;
    
    // Try to detect the focused block from the DOM
    let targetId: number | null = null;
    const active = document.activeElement;
    if (active) {
      const blockEl = active.closest('[data-block-id]') as HTMLElement | null;
      if (blockEl) {
        const blockId = blockEl.dataset.blockId;
        if (blockId) {
          const runtime = getNodeGraphRuntime();
          const graphNode = runtime.getNode(blockId);
          if (graphNode?.serverId) {
            targetId = graphNode.serverId;
          }
        }
      }
    }
    
    // Use detected block, or fall back to current node
    setPropertyTargetNodeId(targetId ?? node.id);
    setShowPropertyPopup(true);
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

  // Resolve extends details from IDs.
  // allClasses is unpaginated and contains all class nodes.
  const extendsDetails = useMemo(() => {
    if (!extendsData || extendsData.length === 0) return [];
    return extendsData
      .map(ext => allClasses?.find(n => n.id === ext.extends_class_node_id))
      .filter((n): n is Node => n !== undefined);
  }, [extendsData, allClasses]);
  
  // Check if node is used as a class — skip if queries are hidden to avoid API call
  const { data: classedNodes } = useNodesWithClass(showQueries ? (node?.id ?? 0) : null);
  
  // Section metadata hooks — skip if queries are hidden to avoid API calls
  useLinkedReferencesCount(showQueries ? nodeId : 0);
  
  // Context menu state
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });

  // Top-bar 3-dot menu state
  const [showTopBarMenu, setShowTopBarMenu] = useState(false);
  const [topBarMenuPos, setTopBarMenuPos] = useState({ x: 0, y: 0 });
  const topBarMenuBtnRef = useRef<HTMLButtonElement>(null);
  const topBarMenuClosedAtRef = useRef(0);
  
  // Cover image picker state
  const [isCoverImagePickerOpen, setIsCoverImagePickerOpen] = useState(false);
  
  // Banner and cover collapse/drag states
  const [isBannerCollapsed, setIsBannerCollapsed] = useState(true);
  const [isCoverCollapsed, setIsCoverCollapsed] = useState(true);
  const [isBannerDragging, setIsBannerDragging] = useState(false);
  const [isCoverDragging, setIsCoverDragging] = useState(false);
  const [isBannerHovered, setIsBannerHovered] = useState(false);
  const [isCoverHovered, setIsCoverHovered] = useState(false);
  // Auto-enable lightweight live sync when viewing a page
  const liveSyncStatus = useLivePageSync({ nodeUuid: node?.is_page ? node?.uuid ?? null : null, pageId: node?.id ?? null });
  
  // Determine node type from the data if not explicitly provided
  const resolvedType: NodeViewType = node?.is_page ? 'page' : 'block';
  
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
    const nodeProps = node.properties as Record<number, unknown>;
    
    for (const prop of allProperties) {
      if (prop.type === 'text') {
        const value = nodeProps[prop.id];
        if (typeof value === 'number') {
          blockIds.add(value);
        } else if (Array.isArray(value)) {
          // Multi-value text properties store an array of block IDs
          for (const v of value) {
            if (typeof v === 'number') blockIds.add(v);
          }
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
      
      // Skip comment blocks (they appear in the comments sidebar section)
      if (child.is_comment) continue;
      
      // Skip blocks that are referenced by text properties (they appear in PropertiesSection)
      if (textPropertyBlockIds.has(child.id)) continue;
      
      if (child.is_page) {
        pages.push(child);
      } else {
        blocks.push(child);
      }
    }
    
    return { blockChildren: blocks, pageChildren: pages };
  }, [node?.children, node?.id, textPropertyBlockIds]);
  
  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  }, []);
  
  const handleCloseContextMenu = useCallback(() => {
    setShowContextMenu(false);
  }, []);

  // Top-bar 3-dot menu handlers
  const handleTopBarMenuClick = useCallback(() => {
    // If the menu was just closed by the outside-click handler (triggered by clicking
    // this same button), don't reopen it — this gives the correct toggle behaviour.
    if (Date.now() - topBarMenuClosedAtRef.current < 200) return;
    if (topBarMenuBtnRef.current) {
      const rect = topBarMenuBtnRef.current.getBoundingClientRect();
      setTopBarMenuPos({ x: rect.left, y: rect.bottom + 4 });
    }
    setShowTopBarMenu(true);
  }, []);

  const handleCloseTopBarMenu = useCallback(() => {
    topBarMenuClosedAtRef.current = Date.now();
    setShowTopBarMenu(false);
  }, []);

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
  
  // Loading state
  if (isLoading) {
    return {
      header: <MainContentTopbar />,
      content: (
        <article className={`node-view node-view--loading ${viewMode}`}>
          <div className="loading-state"><div className="loading-state__spinner" /></div>
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
  const baseHeaderContent = (
    <MainContentTopbar
      left={
        <NodeBreadcrumbs
          nodeId={nodeId}
          nodeType={resolvedType}
          onNavigate={(id) => openNode(id)}
          propertyContext={undefined}
          parentLocked={node.parent_locked}
          editable={!isAlias}
          className="node-view-breadcrumbs"
        />
      }
      right={
        <div className="node-view-controls">
          {/* Card layout selector - only visible in card mode */}
          {contentDisplayMode === 'card' && (
            <div className="card-layout-selector">
              <Button 
                variant="ghost"
                size="sm"
                icon={"mdi mdi-card-outline"}
                className={`card-layout-option ${useAppStore.getState().cardLayout === 'no-cover' ? 'card-layout-option--active' : ''}`}
                onClick={() => useAppStore.getState().setCardLayout('no-cover')}
                title="No cover"
              />
              <Button 
                variant="ghost"
                size="sm"
                icon={"mdi mdi-dock-left"}
                className={`card-layout-option ${useAppStore.getState().cardLayout === 'cover-left' ? 'card-layout-option--active' : ''}`}
                onClick={() => useAppStore.getState().setCardLayout('cover-left')}
                title="Cover left"
              />
              <Button 
                variant="ghost"
                size="sm"
                icon={"mdi mdi-dock-right"}
                className={`card-layout-option ${useAppStore.getState().cardLayout === 'cover-right' ? 'card-layout-option--active' : ''}`}
                onClick={() => useAppStore.getState().setCardLayout('cover-right')}
                title="Cover right"
              />
              <Button 
                variant="ghost"
                size="sm"
                icon={"mdi mdi-dock-top"}
                className={`card-layout-option ${useAppStore.getState().cardLayout === 'cover-top' ? 'card-layout-option--active' : ''}`}
                onClick={() => useAppStore.getState().setCardLayout('cover-top')}
                title="Cover top"
              />
            </div>
          )}

          {/* Bullet/Card mode selector - for blocks, document mode is not available */}
          <SelectionButton
            options={resolvedType === 'block' ? [
              { value: 'bullet', icon: "mdi mdi-format-list-bulleted", label: 'Bullet mode' },
              { value: 'card', icon: "mdi mdi-view-grid", label: 'Card mode' },
            ] : [
              { value: 'bullet', icon: "mdi mdi-format-list-bulleted", label: 'Bullet mode' },
              { value: 'document', icon: "mdi mdi-text-box-outline", label: 'Document mode' },
              { value: 'card', icon: "mdi mdi-view-grid", label: 'Card mode' },
            ]}
            value={contentDisplayMode}
            onChange={(val) => useAppStore.getState().setContentDisplayMode(val as 'bullet' | 'document' | 'card')}
            size="sm"
          />

          {/* 3-dot context menu button */}
          <Button
            ref={topBarMenuBtnRef}
            variant="ghost"
            size="sm"
            icon={"mdi mdi-dots-vertical"}
            title="More actions"
            onClick={handleTopBarMenuClick}
            className={showTopBarMenu ? 'active' : ''}
          />
        </div>
      }
    />
  );

  // Top-bar 3-dot menu (rendered here so it shares state with the button above)
  const topBarMenu = showTopBarMenu ? (
    resolvedType === 'page' ? (
      <PageContextMenu
        node={node}
        position={topBarMenuPos}
        onClose={handleCloseTopBarMenu}
      />
    ) : (
      <BlockContextMenu
        node={node}
        position={topBarMenuPos}
        onClose={handleCloseTopBarMenu}
      />
    )
  ) : null;

  const headerContent = (
    <>
      {baseHeaderContent}
      {topBarMenu}

    </>
  );

  // Build main content
  const mainContentInner = (
    <>
      {/* Page Header or Block Header based on variant */}
      {resolvedType === 'page' ? (
        <>
          {/* Banner Image - before entire header section */}
          {showBanner && (
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
              <Icon path={"mdi mdi-chevron-down"} size={0.7} rotate={isBannerCollapsed ? 0 : 180} />
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
                  <Icon path={"mdi mdi-image-outline"} size={0.8} />
                  <span>Add banner</span>
                </Button>
              )}
            </div>
          </div>
          )}
          
          {/* Grid layout: Header content on left | Cover on right */}
          {showPageHeader && (<>
          <div className="page-header-section">
            {/* Row 1: Page Header (title + icon) */}
            <div className="page-header-section__header">
              <PageHeader
                page={node}
                effectiveClasses={effectiveClasses}
                aliasedNode={aliasedNode}
                onContextMenu={handleContextMenu}
              />
            </div>
            
            {/* Cover Image */}
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
                <Icon path={"mdi mdi-chevron-left"} size={0.7} rotate={isCoverCollapsed ? 0 : 180} />
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
                    <Icon path={"mdi mdi-image-outline"} size={0.8} />
                  </button>
                )}
              </div>
            </div>
          </div>

          <NodeMetadataSection
            node={node}
            pageClassDetails={pageClassDetails}
            pageTagDetails={pageTagDetails}
            extendsDetails={extendsDetails}
            pageAliasDetails={pageAliasDetails}
            aliasedNode={aliasedNode}
            isAlias={isAlias}
            onNavigateToNode={handleNavigateToNode}
            onNavigateToAlias={handleNavigateToAlias}
            onRemoveClass={handleRemoveClass}
            onAddClass={handleAddClass}
            onCreateClass={handleCreateClass}
            onConvertToClass={handleConvertToClass}
            onNodeColorChange={handleNodeColorChange}
            canRemoveClass={isAlias ? () => false : (n: Node) => !isNonRemovableClass(n.uuid)}
            canAddClass={isAlias ? () => false : (n: Node) => !isBlockOnlyClass(n.uuid)}
            onRemoveTag={handleRemoveTag}
            onAddTag={handleAddTag}
            onCreateTag={handleCreateTag}
            onRemoveAlias={handleRemoveAlias}
            onAddAlias={handleAddAlias}
            onRemoveExtends={handleRemoveExtends}
            onAddExtends={handleAddExtends}
            onCreateExtends={handleCreateExtends}
            defaultExpanded={!isMobile}
          />
          </>)}
          
          {/* Properties Section - full width row below header section */}
          {showProperties && (
            <div className="page-properties-section">
              <PropertiesSection 
                nodeId={node.id}
                showHiddenSection={true}
                showAddProperty={true}
                isMainNode={true}
                onNavigateToNode={handleNavigateToNode}
                onOpenInSidebar={(id) => addSidebarCard(id, 'block')}
                defaultCollapsed={propertiesCollapsed}
              />
            </div>
          )}
          
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
        <ClassPropertiesEditor classNodeId={node.id} defaultExpanded={!isMobile} />
      )}
      
      {/* Node Content - Children blocks (pages only, blocks use focused block view) */}
      {resolvedType === 'page' ? (
        <>
          <BlockPresenceOverlay nodeUuid={node.uuid} />
          <NodeContent
            node={node}
            children={blockChildren}
            displayMode={contentDisplayMode}
            totalChildrenCount={node.children?.length || 0}
            editable={workspaceCanWrite}
            canCreate={workspaceCanCreate}
          />
        </>
      ) : (
        /* Focused Block View - renders the block itself as a top-level list item */
        /* Properties for the focused block are rendered inline by BlockPropertiesPlugin */
        <FocusedBlockContent
          node={node}
          onAddSidebarCard={(id) => addSidebarCard(id, 'block')}
          displayMode={contentDisplayMode}
          editable={workspaceCanWrite}
          canCreate={workspaceCanCreate}
        />
      )}
      
      {/* Query sections */}
      {showQueries && (
        <>
          {/* Extended By section - shows classes that extend this class (class nodes only) */}
          {isClassNode && (
            <QuerySection
              nodeId={node.id}
              nodeUuid={node.uuid}
              nodeName={node.name}
              viewType="extended_by"
              title="Extended By"
              icon={<TableIcon size="sm" />}
              hideWhenEmpty={true}
              defaultExpanded={true}
              onNodeClick={(targetNodeId) => openNode(targetNodeId)}
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
              nodeName={node.name}
              viewType="classed_nodes"
              title="Nodes"
              icon={<TableIcon size="sm" />}
              hideWhenEmpty={false}
              defaultExpanded={true}
              onNodeClick={(targetNodeId) => openNode(targetNodeId)}
              onBlockCreated={(targetNodeId) => addSidebarCard(targetNodeId, 'block')}
            />
          )}
          
          {/* Child pages section - shows pages that have this node as parent (pages only) */}
          {resolvedType === 'page' && (
            <QuerySection
              nodeId={node.id}
              nodeUuid={node.uuid}
              nodeName={node.name}
              viewType="child_pages"
              title="Children"
              icon={<PageIcon size="sm" />}
              hideWhenEmpty={true}
              defaultExpanded={true}
              onNodeClick={(targetNodeId) => openNode(targetNodeId)}
              onBlockCreated={(targetNodeId) => addSidebarCard(targetNodeId, 'block')}
              hideViewManagement={true}
            />
          )}
          
          {/* Daily page task sections */}
          {isDayUuid(node.uuid) && (
            <>
              <QuerySection
                nodeId={node.id}
                nodeUuid={node.uuid}
                nodeName={node.name}
                viewType="classed_nodes"
                title="Scheduled Tasks"
                icon={<Icon path="mdi-calendar-check" />}
                hideWhenEmpty={true}
                defaultExpanded={true}
                queryAST={buildScheduledForDayQueryAST(node.uuid)}
                hideViewManagement={true}
                onNodeClick={(targetNodeId) => openNode(targetNodeId)}
                onBlockCreated={(targetNodeId) => addSidebarCard(targetNodeId, 'block')}
              />
              {node.uuid === getTodayDayUuid() && (
                <QuerySection
                  nodeId={node.id}
                  nodeUuid={node.uuid}
                  nodeName={node.name}
                  viewType="classed_nodes"
                  title="Overdue Tasks"
                  icon={<Icon path="mdi-calendar-alert" />}
                  hideWhenEmpty={true}
                  defaultExpanded={true}
                  queryAST={buildOverdueQueryAST()}
                  hideViewManagement={true}
                  onNodeClick={(targetNodeId) => openNode(targetNodeId)}
                  onBlockCreated={(targetNodeId) => addSidebarCard(targetNodeId, 'block')}
                />
              )}
            </>
          )}
          
          {/* Linked References - shows all references to this node (universal for all nodes) */}
          <QuerySection
            nodeId={node.id}
            nodeUuid={node.uuid}
            nodeName={node.name}
            viewType="linked_references"
            title="Linked References"
            icon={<LinkIcon size="sm" />}
            defaultExpanded={!linkedRefsCollapsed}
            hideWhenEmpty={true}
            onNodeClick={(targetNodeId) => openNode(targetNodeId)}
            onBlockCreated={(targetNodeId) => addSidebarCard(targetNodeId, 'block')}
          />
          
          {/* Unlinked References - content search for the current node's name (pages only) */}
          {resolvedType === 'page' && (
            <QuerySection
              nodeId={node.id}
              nodeUuid={node.uuid}
              nodeName={node.name}
              viewType="unlinked_references"
              title="Unlinked References"
              icon={<SearchIcon size="sm" />}
              defaultExpanded={false}
              hideWhenEmpty={true}
              onNodeClick={(targetNodeId) => openNode(targetNodeId)}
              onBlockCreated={(targetNodeId) => addSidebarCard(targetNodeId, 'block')}
            />
          )}
          
          {/* Activity Log — chronological history of edits, links, property changes */}
          <NodeActivityLogSection
            nodeId={node.id}
            defaultExpanded={false}
          />
        </>
      )}
      
      {/* Footer */}
      {showFooter && (
        <footer className="node-view-footer">
          <div className="node-view-metadata">
            <span>Created: <a role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }} className="node-view-metadata-date" onClick={() => navigateToDay(node.create_date)}>{formatDate(new Date(node.create_date), useSettingsStore.getState().dateFormat)}</a></span>
            <span>Updated: <a role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }} className="node-view-metadata-date" onClick={() => navigateToDay(node.write_date)}>{formatDate(new Date(node.write_date), useSettingsStore.getState().dateFormat)}</a></span>
            {liveSyncStatus !== 'connected' && node?.is_page && (
              <span className={`live-sync-status live-sync-status--${liveSyncStatus}`} title={`Live sync ${liveSyncStatus}`}>
                {liveSyncStatus === 'connecting' ? 'Connecting…' : liveSyncStatus === 'error' ? 'Sync error' : 'Offline'}
              </span>
            )}
          </div>
          <WordCount node={node} />
        </footer>
      )}
      
      {/* Context Menu (right-click) */}
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
          onClose={() => { setShowPropertyPopup(false); setPropertyTargetNodeId(null); }}
          title="Add Property"
          size="sm"
        >
          <PropertySuggestionPopup
            isOpen={showPropertyPopup}
            onClose={() => { setShowPropertyPopup(false); setPropertyTargetNodeId(null); }}
            onSelect={handleSelectProperty}
            onCreate={handleCreateNewProperty}
            excludeIds={[]}
          />
        </Modal>
      )}
    </>
  );

  const mainContent = (
    <ReferencedNodesProvider referencedNodes={node?.referenced_nodes}>
      <article 
        className={`node-view node-view--${resolvedType} ${viewMode}`}
      >
        {mainContentInner}
      </article>
    </ReferencedNodesProvider>
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
  const { header } = NodeView(props);
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

