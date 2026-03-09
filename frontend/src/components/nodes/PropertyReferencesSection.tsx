/**
 * PropertyReferencesSection Component
 * 
 * Renders pages that reference the current node via relation properties
 * (e.g. a page with "author" property set to this page).
 * 
 * Shown at the top of linked references, separated by a horizontal divider,
 * outside of any group-by grouping.
 * 
 * Uses standard Lexical BlockEditor for rendering pages with their content,
 * providing consistent block interactions (bullets, collapse arrows, etc.).
 */
import { useMemo, useCallback, useId } from 'react';
import type { Node, LinkedReference } from '@/types';
import { BlockEditor } from '@/editor/BlockEditor';
import { useSettingsStore } from '@/stores';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { useContentSave } from '@/hooks';
import './PropertyReferencesSection.css';

interface PropertyRefItem {
  /** The original linked reference data */
  ref: LinkedReference;
  /** The page node (source_page or source_node if it is a page) */
  pageNode: Node;
  /** Property ID that contains the reference */
  propertyId: number;
  /** Property name for display */
  propertyName: string;
}

interface PropertyReferencesSectionProps {
  /** Property reference items to display */
  items: PropertyRefItem[];
  /** Whether content is editable */
  editable?: boolean;
  /** Callback when a node is clicked */
  onNodeClick?: (node: Node) => void;
  /** Callback when a node is shift-clicked (open in sidebar) */
  onNodeShiftClick?: (node: Node) => void;
  /** Callback when a class is added to a block */
  onAddClass?: (blockId: number, classId: number) => void;
}

/**
 * Apply collapse level to node children recursively
 * Children at depth >= collapseLevel will be marked as collapsed
 */
function applyCollapseLevelToChildren(node: Node, collapseLevel: number, currentDepth: number = 0): Node {
  if (!node.children || node.children.length === 0 || collapseLevel === 0) {
    return node;
  }

  const processedChildren = node.children.map(child => {
    const childDepth = currentDepth + 1;
    const shouldCollapse = childDepth >= collapseLevel;
    
    return applyCollapseLevelToChildren(
      {
        ...child,
        collapsed: shouldCollapse,
      },
      collapseLevel,
      childDepth
    );
  });

  return {
    ...node,
    children: processedChildren,
  };
}

/**
 * Flatten a node tree into a flat array while preserving parent-child relationships
 */
function flattenNodes(nodes: Node[]): Node[] {
  const result: Node[] = [];
  const collect = (n: Node) => {
    result.push(n);
    if (n.children) {
      for (const child of n.children) {
        collect(child);
      }
    }
  };
  for (const n of nodes) {
    collect(n);
  }
  return result;
}

/**
 * Section displaying pages that reference via relation properties.
 * Uses BlockEditor for standard block rendering with collapse support.
 */
export function PropertyReferencesSection({
  items,
  editable = false,
  onNodeClick,
  onNodeShiftClick,
  onAddClass,
}: PropertyReferencesSectionProps) {
  const viewId = useId();
  const linkedRefsCollapseLevel = useSettingsStore(state => state.linkedRefsCollapseLevel);
  
  // Use content save hook for persistence
  const { handleContentChange: saveContent } = useContentSave();

  // Process items into page nodes with collapsed children
  const pageNodes = useMemo(() => {
    return items.map(item => {
      // Get the source node which has the children
      const sourceNode = item.ref.source_node;
      
      // Create a page node from source_page or source_node
      const pageNode = item.pageNode;
      
      // Build the node with its children, applying collapse level
      // The page itself starts collapsed (depth 0), children start at depth 1
      const nodeWithChildren: Node = {
        ...pageNode,
        // Use source_node's children if available
        children: sourceNode.children || [],
        // Page itself is collapsed initially
        collapsed: true,
      };
      
      // Apply collapse level to children (they will be collapsed when page is expanded)
      return applyCollapseLevelToChildren(nodeWithChildren, linkedRefsCollapseLevel, 0);
    });
  }, [items, linkedRefsCollapseLevel]);

  // Flatten all nodes for BlockEditor
  const allNodes = useMemo(() => {
    return flattenNodes(pageNodes);
  }, [pageNodes]);

  // Handle navigation
  const handleNavigateToNode = useCallback((blockId: string) => {
    const node = allNodes.find(n => n.uuid === blockId);
    if (node) {
      onNodeClick?.(node);
    }
  }, [allNodes, onNodeClick]);

  // Handle shift-click (open in sidebar)
  const handleOpenInSidebar = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    if (graphNode?.serverId) {
      const targetNode = allNodes.find(n => n.id === graphNode.serverId);
      if (targetNode) {
        onNodeShiftClick?.(targetNode);
      } else {
        onNodeShiftClick?.({ id: graphNode.serverId, is_page: graphNode.isPage } as Node);
      }
      return;
    }
    // Fallback: UUID-based lookup
    const node = allNodes.find(n => n.uuid === blockId);
    if (node) {
      onNodeShiftClick?.(node);
    }
  }, [allNodes, onNodeShiftClick]);

  // Handle content changes (bridge from UUID to serverId for persistence)
  const handleContentChange = useCallback((blockId: string, content: string) => {
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    const serverId = graphNode?.serverId;
    if (serverId != null) {
      saveContent(serverId, content);
    }
  }, [saveContent]);

  if (items.length === 0) return null;

  return (
    <div className="property-references-section">
      <div className="property-references-section__list">
        <BlockEditor
          editorId={`prop-refs-${viewId}`}
          nodes={allNodes}
          mode="list"
          readOnly={!editable}
          onNavigateToNode={handleNavigateToNode}
          onOpenInSidebar={handleOpenInSidebar}
          onContentChange={handleContentChange}
          onAddClass={onAddClass}
        />
      </div>
      <hr className="property-references-section__divider" />
    </div>
  );
}

export type { PropertyRefItem };
export default PropertyReferencesSection;
