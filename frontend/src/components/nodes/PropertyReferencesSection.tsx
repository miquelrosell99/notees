/**
 * PropertyReferencesSection Component
 * 
 * Renders pages that reference the current node via relation properties
 * (e.g. a page with "author" property set to this page).
 * 
 * Shown at the top of linked references, separated by a horizontal divider,
 * outside of any group-by grouping.
 * 
 * Each page is shown collapsed by default. When expanded, it shows
 * PropertiesSection filtered to only the relevant property — the exact same
 * component used in the main node view.
 */
import { useState, useCallback } from 'react';
import type { Node, LinkedReference } from '@/types';
import { NodeInline } from '../blocks/NodeInline';
import { PropertiesSection } from '../properties/PropertiesSection';
import { ChevronRightIcon, ChevronDownIcon } from '../core/icons';
import { useAppStore } from '@/stores';
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
 * A single collapsible property reference page item.
 * Uses the same PropertiesSection as the main node view, filtered to the relevant property.
 */
function PropertyRefPageItem({
  item,
  editable = false,
  onNodeClick,
  onNodeShiftClick,
}: {
  item: PropertyRefItem;
  editable?: boolean;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const openNode = useAppStore(state => state.openNode);

  const { pageNode, propertyId, ref } = item;

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
          />
        ))}
      </div>
      <hr className="property-references-section__divider" />
    </div>
  );
}

export type { PropertyRefItem };
export default PropertyReferencesSection;
