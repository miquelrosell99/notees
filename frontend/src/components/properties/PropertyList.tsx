/**
 * PropertyList Component
 * 
 * A reusable component for displaying a list of property rows in a
 * two-column table layout (Capacities-style):
 *   Left column: property icon + name
 *   Right column: property value
 * 
 * Features:
 * - Clean table layout with subtle row dividers
 * - Hidden properties section
 * - Context menu support (at row level)
 * - Default icons for property types when no custom icon is set
 * 
 * NOTE: Moved out of core/ - has domain knowledge (Property type)
 */
import { useState, useCallback, useMemo, useRef, type ReactNode } from 'react';
import type { Property, PropertyType, Node } from '@/types/api';
import { useNavigationStore } from '@/stores';
import { useNode } from '@/hooks';
import { NodeInline } from '@/components/blocks/NodeInline';
import { ChevronRightIcon } from '@/components/core/icons';
import { ContextMenu, type ContextMenuItem } from '@/components/core/ContextMenu';
import { PageContextMenu } from '@/components/nodes/NodeContextMenu';
import './PropertyList.css';

/** Default MDI icons for each property type (used when no custom icon is set) */
const PROPERTY_TYPE_ICONS: Record<PropertyType, string> = {
  text: 'mdiFormatText',
  integer: 'mdiPound',
  float: 'mdiDecimal',
  boolean: 'mdiCheckboxMarkedOutline',
  date: 'mdiCalendar',
  selection: 'mdiFormatListBulleted',
  node: 'mdiLink',
  url: 'mdiLinkVariant',
  email: 'mdiEmail',
  image: 'mdiImage',
};

/** Get icon for a property - uses custom icon if set, otherwise default MDI icon for type */
function getPropertyIcon(property: Property): string {
  return property.icon || PROPERTY_TYPE_ICONS[property.type] || 'mdiFileDocumentOutline';
}

export interface PropertyEntry {
  /** The property definition */
  property: Property;
  /** Current value */
  value: unknown;
  /** Source of the property (e.g., type name) */
  source?: string;
  /** Whether this property is hidden by default */
  hidden?: boolean;
}

export interface PropertyListProps {
  /** List of property entries to display */
  properties: PropertyEntry[];
  /** Whether the list is read-only */
  readOnly?: boolean;
  /** Whether to show hidden properties section */
  showHiddenSection?: boolean;
  /** Whether hidden section is initially expanded */
  defaultShowHidden?: boolean;
  /** Render function for property values */
  renderValue: (entry: PropertyEntry, readOnly: boolean) => ReactNode;
  /** Handler for property name clicks (for editing) */
  onPropertyNameClick?: (property: Property, event: React.MouseEvent) => void;
  /** Handler for property name right-clicks (context menu) */
  onPropertyContextMenu?: (property: Property, event: React.MouseEvent) => void;
  /** Context menu items generator */
  getContextMenuItems?: (property: Property) => ContextMenuItem[];
  /** Additional className */
  className?: string;
  /** Handler when clicking on a node value */
  onNodeValueClick?: (nodeId: number) => void;
  /** Handler when shift+clicking on a node value */
  onNodeValueShiftClick?: (nodeId: number) => void;
}

/** Check if an entry is a multi-value text property with multiple values */
function isMultiTextEntry(entry: PropertyEntry): entry is PropertyEntry & { value: number[] } {
  return entry.property.type === 'text' && entry.property.multi === true && Array.isArray(entry.value) && entry.value.length > 1;
}

/** Render a list of property entries as rows, expanding multi-text into grouped rows */
function renderPropertyRows(
  entries: PropertyEntry[],
  readOnly: boolean,
  renderValue: (entry: PropertyEntry, readOnly: boolean) => ReactNode,
  onNameClick: PropertyListProps['onPropertyNameClick'],
  onPropertyContextMenu: PropertyListProps['onPropertyContextMenu'],
  getContextMenuItems: PropertyListProps['getContextMenuItems'],
  onValueClick: (nodeId: number) => void,
  onValueShiftClick: (nodeId: number) => void,
) {
  return entries.map(entry => {
    if (isMultiTextEntry(entry)) {
      // Expand into multiple rows, one per block ID
      const blockIds = entry.value;
      return (
        <div key={entry.property.id} className="property-row-group">
          {blockIds.map((blockId, idx) => (
            <PropertyRow
              key={`${entry.property.id}-${blockId}`}
              entry={{ ...entry, value: blockId }}
              readOnly={readOnly}
              renderValue={renderValue}
              onNameClick={onNameClick}
              onPropertyContextMenu={onPropertyContextMenu}
              getContextMenuItems={getContextMenuItems}
              onValueClick={onValueClick}
              onValueShiftClick={onValueShiftClick}
              hideLabel={idx > 0}
            />
          ))}
        </div>
      );
    }
    return (
      <PropertyRow
        key={entry.property.id}
        entry={entry}
        readOnly={readOnly}
        renderValue={renderValue}
        onNameClick={onNameClick}
        onPropertyContextMenu={onPropertyContextMenu}
        getContextMenuItems={getContextMenuItems}
        onValueClick={onValueClick}
        onValueShiftClick={onValueShiftClick}
      />
    );
  });
}

/**
 * PropertyList component for displaying property rows.
 */
export function PropertyList({
  properties,
  readOnly = false,
  showHiddenSection = true,
  defaultShowHidden = false,
  renderValue,
  onPropertyNameClick,
  onPropertyContextMenu,
  getContextMenuItems,
  className = '',
  onNodeValueClick,
  onNodeValueShiftClick,
}: PropertyListProps) {
  const [showHidden, setShowHidden] = useState(defaultShowHidden);
  
  // Default handlers using store if not provided
  const openNode = useNavigationStore(state => state.openNode);
  const addSidebarCard = useNavigationStore(state => state.addSidebarCard);
  
  const handleNodeValueClick = useCallback((nodeId: number) => {
    if (onNodeValueClick) {
      onNodeValueClick(nodeId);
    } else {
      openNode(nodeId);
    }
  }, [onNodeValueClick, openNode]);
  
  const handleNodeValueShiftClick = useCallback((nodeId: number) => {
    if (onNodeValueShiftClick) {
      onNodeValueShiftClick(nodeId);
    } else {
      addSidebarCard(nodeId, 'block');
    }
  }, [onNodeValueShiftClick, addSidebarCard]);
  
  // Split into visible and hidden properties
  const visibleProperties = properties.filter(p => !p.hidden);
  const hiddenProperties = properties.filter(p => p.hidden);

  return (
    <div className={`property-table ${className}`}>
      {/* Visible properties */}
      <div className="property-table__body">
        {renderPropertyRows(
          visibleProperties,
          readOnly,
          renderValue,
          onPropertyNameClick,
          onPropertyContextMenu,
          getContextMenuItems,
          handleNodeValueClick,
          handleNodeValueShiftClick,
        )}
      </div>

      {/* Hidden properties section */}
      {showHiddenSection && hiddenProperties.length > 0 && (
        <div className="property-table__hidden-section">
          <button
            className={`property-table__hidden-toggle ${showHidden ? 'expanded' : ''}`}
            onClick={() => setShowHidden(!showHidden)}
          >
            <ChevronRightIcon size="xs" />
            <span>Hidden properties ({hiddenProperties.length})</span>
          </button>

          {showHidden && (
            <div className="property-table__body">
              {renderPropertyRows(
                hiddenProperties,
                readOnly,
                renderValue,
                onPropertyNameClick,
                onPropertyContextMenu,
                getContextMenuItems,
                handleNodeValueClick,
                handleNodeValueShiftClick,
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface PropertyRowProps {
  entry: PropertyEntry;
  readOnly: boolean;
  renderValue: (entry: PropertyEntry, readOnly: boolean) => ReactNode;
  onNameClick?: (property: Property, event: React.MouseEvent) => void;
  onPropertyContextMenu?: (property: Property, event: React.MouseEvent) => void;
  getContextMenuItems?: (property: Property) => ContextMenuItem[];
  /** Handler when clicking on a node value */
  onValueClick?: (nodeId: number) => void;
  /** Handler when shift+clicking on a node value */
  onValueShiftClick?: (nodeId: number) => void;
  /** Whether to hide the label (for multi-row continuation) */
  hideLabel?: boolean;
}

/**
 * PropertyRow component - renders a single property row with context menu
 * Uses Block component in readonly mode for the property name display
 */
function PropertyRow({
  entry,
  readOnly,
  renderValue,
  onNameClick,
  onPropertyContextMenu,
  getContextMenuItems,
  onValueClick: _onValueClick,
  onValueShiftClick: _onValueShiftClick,
  hideLabel,
}: PropertyRowProps) {
  const { property, source, value } = entry;
  const rowRef = useRef<HTMLDivElement>(null);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [showNodeValueContextMenu, setShowNodeValueContextMenu] = useState(false);
  const [_nodeValueContextMenuPosition, _setNodeValueContextMenuPosition] = useState({ x: 0, y: 0 });
  
  // Fetch the node for the value if it's a node or date property
  const nodeValueId = (property.type === 'node' || property.type === 'date') && !property.multi && typeof value === 'number' ? value : null;
  const { data: nodeValueData } = useNode(nodeValueId);
  
  // Get navigation functions from store
  const openPropertyView = useNavigationStore(state => state.openPropertyView);
  const addSidebarCard = useNavigationStore(state => state.addSidebarCard);

  const handleNameClick = useCallback((e: React.MouseEvent) => {
    if (!readOnly && onNameClick) {
      onNameClick(property, e);
    }
  }, [readOnly, onNameClick, property]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (readOnly || !getContextMenuItems) return;
    e.preventDefault();
    const row = rowRef.current;
    if (row) {
      const rect = row.getBoundingClientRect();
      setContextMenuPosition({ x: rect.left, y: rect.bottom });
    } else {
      setContextMenuPosition({ x: e.clientX, y: e.clientY });
    }
    setShowContextMenu(true);
    onPropertyContextMenu?.(property, e);
  }, [readOnly, property, onPropertyContextMenu, getContextMenuItems]);

  // Generate context menu items for this row
  const contextMenuItems = getContextMenuItems ? getContextMenuItems(property) : [];
  
  // Handle label click - opens property page
  const handleLabelClick = useCallback(() => {
    openPropertyView(property.id);
  }, [openPropertyView, property.id]);
  
  // Handle shift+click on label - opens property in sidebar
  const handleLabelShiftClick = useCallback(() => {
    addSidebarCard(property.id, 'block');
  }, [addSidebarCard, property.id]);
  
  // Create a minimal node for NodeInline to display the property name
  const propertyAsNode = useMemo<Node>(() => ({
    id: property.id,
    uuid: property.uuid,
    name: property.name,
    icon: getPropertyIcon(property),
    color: null,
    parent_id: null,
    page_id: null,
    sequence: 0,
    collapsed: false,
    active: true,
    is_page: false,
    create_date: property.create_date,
    write_date: property.write_date,
  }), [property]);

  return (
    <>
      <div ref={rowRef} className={`property-row${hideLabel ? ' property-row--continuation' : ''}`} onContextMenu={handleContextMenu}>
        <div className="property-row__label" onClick={handleNameClick}>
          {!hideLabel && (
            <>
              <NodeInline
                name={propertyAsNode.name}
                icon={propertyAsNode.icon}
                isPage={false}
                nodeId={propertyAsNode.id}
                showBullet={false}
                onClick={handleLabelClick}
                onShiftClick={handleLabelShiftClick}
              />
              {source && (
                <span className="property-row__source" title={`From ${source}`}>
                  ({source})
                </span>
              )}
            </>
          )}
        </div>
        <div className="property-row__value">
          {renderValue(entry, readOnly)}
        </div>
      </div>

      {/* Context Menu - rendered at row level */}
      {showContextMenu && contextMenuItems.length > 0 && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenuPosition}
          onClose={() => setShowContextMenu(false)}
        />
      )}
      
      {/* Node Value Context Menu - standard page context menu for node properties */}
      {showNodeValueContextMenu && nodeValueData && (
        <PageContextMenu
          node={nodeValueData}
          position={_nodeValueContextMenuPosition}
          onClose={() => setShowNodeValueContextMenu(false)}
        />
      )}
    </>
  );
}

