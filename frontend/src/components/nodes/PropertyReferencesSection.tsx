/**
 * PropertyReferencesSection Component
 * 
 * Renders pages that reference the current node via relation properties
 * (e.g. a page with "author" property set to this page).
 * 
 * Shown at the top of linked references, separated by a horizontal divider,
 * outside of any group-by grouping.
 * 
 * Each page is shown collapsed by default. When expanded, it shows:
 * - The properties section filtered to only the property containing the reference
 * - All child blocks of the page
 */
import { useState, useCallback, useId } from 'react';
import type { Node, LinkedReference } from '@/types';
import { NodeInline } from '../blocks/NodeInline';
import { PropertiesSection } from '../properties/PropertiesSection';
import { BlockEditor } from '@/editor/BlockEditor';
import { ChevronRightIcon, ChevronDownIcon } from '../core/icons';
import { useAppStore } from '@/stores';
import { sortBySequence } from '@/utils/nodeSort';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { queueContentSave } from '@/hooks/useBlockPersist';
import { getNodeByUuid } from '@/api/nodes';
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
  /** Callback when node content changes */
  onContentChange?: (nodeId: number, content: string) => void;
  /** Callback when a class is added to a block */
  onAddClass?: (blockId: number, classId: number) => void;
}

/**
 * A single collapsible property reference page item.
 */
function PropertyRefPageItem({
  item,
  editable = false,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  onAddClass,
}: {
  item: PropertyRefItem;
  editable?: boolean;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onContentChange?: (nodeId: number, content: string) => void;
  onAddClass?: (blockId: number, classId: number) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const viewId = useId();
  const openNode = useAppStore(state => state.openNode);

  const { pageNode, propertyId, ref } = item;

  // Get all children nodes sorted by sequence
  const childNodes = sortBySequence(
    (ref.source_node.children ?? []).flatMap(function collectAll(n: Node): Node[] {
      return [n, ...(n.children ?? []).flatMap(collectAll)];
    })
  );

  // Handler for navigation from editor
  const handleNavigateToNode = useCallback(async (blockId: string) => {
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    
    if (graphNode?.serverId) {
      onNodeClick?.({ id: graphNode.serverId, is_page: graphNode.isPage } as Node);
      return;
    }

    try {
      const { parseLinkId } = await import('@/lib/astBuilder');
      const { nodeUuid } = parseLinkId(blockId);
      const node = await getNodeByUuid(nodeUuid);
      onNodeClick?.(node);
    } catch {
      // Node not found
    }
  }, [onNodeClick]);

  // Handler for shift-click from editor
  const handleOpenInSidebar = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    if (!graphNode?.serverId) return;
    
    onNodeShiftClick?.({ id: graphNode.serverId, is_page: graphNode.isPage } as Node);
  }, [onNodeShiftClick]);

  // Handler for content changes
  const handleContentChangeBridge = useCallback((blockId: string, content: string) => {
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    const serverId = graphNode?.serverId;
    if (serverId != null) {
      onContentChange?.(serverId, content);
    } else if (graphNode) {
      queueContentSave(blockId, content);
    }
  }, [onContentChange]);

  const handleNavigateToPage = useCallback(() => {
    onNodeClick?.(pageNode);
  }, [onNodeClick, pageNode]);

  const handleOpenPageInSidebar = useCallback(() => {
    onNodeShiftClick?.(pageNode);
  }, [onNodeShiftClick, pageNode]);

  return (
    <div className={`property-ref-item ${isExpanded ? 'property-ref-item--expanded' : ''}`}>
      <div className="property-ref-item__header">
        <button
          type="button"
          className="property-ref-item__toggle"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
        >
          {isExpanded ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />}
        </button>
        <NodeInline
          name={pageNode.name}
          icon={pageNode.icon}
          isPage={pageNode.is_page}
          nodeId={pageNode.id}
          showBullet={true}
          onClick={handleNavigateToPage}
          onShiftClick={handleOpenPageInSidebar}
        />
      </div>
      
      {isExpanded && (
        <div className="property-ref-item__content">
          {/* Filtered properties - only show the property that contains the reference */}
          <div className="property-ref-item__properties">
            <PropertiesSection
              nodeId={ref.source_node.id}
              variant="block"
              readOnly={!editable}
              inline={true}
              filterPropertyIds={[propertyId]}
              showAddProperty={false}
              showHiddenSection={false}
              onNavigateToNode={(id) => openNode(id)}
            />
          </div>

          {/* Child blocks */}
          {childNodes.length > 0 && (
            <div className="property-ref-item__children">
              <BlockEditor
                editorId={`property-ref-${viewId}-${pageNode.id}`}
                nodes={childNodes}
                mode="list"
                readOnly={!editable}
                onNavigateToNode={handleNavigateToNode}
                onOpenInSidebar={handleOpenInSidebar}
                onContentChange={handleContentChangeBridge}
                onAddClass={onAddClass}
                pageId={pageNode.id}
                pageUuid={pageNode.uuid}
                className="property-ref-item__editor"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Section displaying pages that reference via relation properties.
 * Renders above regular linked references, separated by a horizontal divider.
 */
export function PropertyReferencesSection({
  items,
  editable = false,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  onAddClass,
}: PropertyReferencesSectionProps) {
  if (items.length === 0) return null;

  return (
    <div className="property-references-section">
      <div className="property-references-section__list">
        {items.map((item) => (
          <PropertyRefPageItem
            key={`${item.pageNode.id}-${item.propertyId}`}
            item={item}
            editable={editable}
            onNodeClick={onNodeClick}
            onNodeShiftClick={onNodeShiftClick}
            onContentChange={onContentChange}
            onAddClass={onAddClass}
          />
        ))}
      </div>
      <hr className="property-references-section__divider" />
    </div>
  );
}

export type { PropertyRefItem };
export default PropertyReferencesSection;
