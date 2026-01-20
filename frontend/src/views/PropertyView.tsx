/**
 * PropertyView Component
 * 
 * A dedicated view for displaying all nodes that have a specific property set.
 * Shows the property information at the top and a NodeList of all nodes with values.
 * 
 * Features:
 * - Property header with icon, name, type info
 * - NodeList with property value as a column
 * - Multiple view modes (table, list, kanban, calendar)
 * - Navigation to nodes on click
 */
import { useMemo } from 'react';
import type { Property, Node } from '@/types/api';
import { useProperty, useNodesWithProperty } from '@/hooks';
import { NodeList, type NodeListColumn, type NodeListViewMode, type NodeListItem } from '../components/NodeList';
import { NodeIcon } from '../components/icons';
import './PropertyView.css';

/** Property type display info */
const PROPERTY_TYPES: Record<string, { label: string; icon: string }> = {
  text: { label: 'Text', icon: '' },
  integer: { label: 'Number', icon: '' },
  float: { label: 'Decimal', icon: '' },
  boolean: { label: 'Checkbox', icon: '' },
  date: { label: 'Date', icon: '' },
  selection: { label: 'Selection', icon: '' },
  node: { label: 'Node', icon: '' },
};

interface PropertyViewProps {
  /** Property ID to display */
  propertyId: number;
  /** Initial view mode */
  defaultViewMode?: NodeListViewMode;
  /** Navigate to a node */
  onNavigateToNode?: (nodeId: number) => void;
  /** Open a node in sidebar */
  onOpenInSidebar?: (nodeId: number) => void;
}

export function PropertyView({
  propertyId,
  defaultViewMode = 'table',
  onNavigateToNode,
  onOpenInSidebar,
}: PropertyViewProps) {
  // Fetch property details
  const { data: property, isLoading: propertyLoading } = useProperty(propertyId);
  
  // Fetch nodes with this property using property ID
  const { data: nodesWithProperty, isLoading: nodesLoading } = useNodesWithProperty(
    property ? propertyId : null
  );
  
  // Generate columns for the NodeList
  const columns = useMemo<NodeListColumn[]>(() => {
    if (!property) return [];
    
    return [
      {
        key: 'name',
        label: 'Name',
        icon: '',
        width: '40%',
      },
      {
        key: property.name.toLowerCase().replace(/\s+/g, '_'),
        label: property.name,
        icon: property.icon || PROPERTY_TYPES[property.type]?.icon || '',
        propertyId: property.id,
        width: '40%',
        render: (_node: Node, value: unknown) => {
          return <PropertyValueDisplay property={property} value={value} />;
        },
      },
      {
        key: 'updated',
        label: 'Updated',
        icon: '',
        width: '20%',
        render: (node: Node) => {
          const date = new Date(node.write_date);
          return (
            <span className="property-view-date">
              {date.toLocaleDateString()}
            </span>
          );
        },
      },
    ];
  }, [property]);
  
  // Convert nodes to NodeListItems
  const items = useMemo<NodeListItem[]>(() => {
    if (!nodesWithProperty || !property) return [];
    
    const propKey = property.name.toLowerCase().replace(/\s+/g, '_');
    
    return nodesWithProperty.map(node => ({
      node,
      propertyValues: {
        [propKey]: (node.properties as Record<string, unknown>)?.[propKey],
      },
    }));
  }, [nodesWithProperty, property]);
  
  // Handle node click
  const handleNodeClick = (node: Node) => {
    onNavigateToNode?.(node.id);
  };
  
  // Handle shift+click (open in sidebar)
  const handleNodeShiftClick = (node: Node) => {
    onOpenInSidebar?.(node.id);
  };
  
  const isLoading = propertyLoading || nodesLoading;
  const typeInfo = property ? PROPERTY_TYPES[property.type] : null;
  
  if (isLoading && !property) {
    return (
      <div className="property-view loading">
        <div className="property-view-skeleton">Loading property...</div>
      </div>
    );
  }
  
  if (!property) {
    return (
      <div className="property-view error">
        <p>Property not found</p>
      </div>
    );
  }
  
  return (
    <div className="property-view">
      {/* Property Header */}
      <header className="property-view-header">
        <div className="property-view-icon">
          {property.icon || typeInfo?.icon || ''}
        </div>
        <div className="property-view-info">
          <h1 className="property-view-title">{property.name}</h1>
          <div className="property-view-meta">
            <span className="property-view-type">
              {typeInfo?.icon} {typeInfo?.label || property.type}
            </span>
            {property.multi && (
              <span className="property-view-badge">Multi-value</span>
            )}
            {property.is_system && (
              <span className="property-view-badge system">System</span>
            )}
          </div>
        </div>
      </header>
      
      {/* Property Options (for selection type) */}
      {property.type === 'selection' && property.options.length > 0 && (
        <div className="property-view-options">
          <h3 className="property-view-options-title">Available Choices</h3>
          <div className="property-view-options-list">
            {property.options.map(option => (
              <span key={option.id} className="property-view-option">
                {option.icon && <span className="property-view-option-icon">{option.icon}</span>}
                {option.name}
              </span>
            ))}
          </div>
        </div>
      )}
      
      {/* Nodes with this property */}
      <section className="property-view-nodes">
        <NodeList
          title={`Nodes with "${property.name}"`}
          items={items}
          columns={columns}
          defaultViewMode={defaultViewMode}
          showViewToggle={true}
          isLoading={nodesLoading}
          emptyMessage={`No nodes have the "${property.name}" property set.`}
          showCreate={false}
          collapsible={false}
          onItemClick={handleNodeClick}
          onItemShiftClick={handleNodeShiftClick}
        />
      </section>
    </div>
  );
}

/**
 * Display a property value based on its type
 */
function PropertyValueDisplay({
  property,
  value,
}: {
  property: Property;
  value: unknown;
}) {
  if (value === null || value === undefined || value === '') {
    return <span className="property-view-value-empty">—</span>;
  }
  
  switch (property.type) {
    case 'boolean':
      return (
        <span className="property-view-value-boolean">
          {value ? 'Yes' : 'No'}
        </span>
      );
    
    case 'integer':
    case 'float':
      return (
        <span className="property-view-value-number">
          {String(value)}
        </span>
      );
    
    case 'date':
      const date = new Date(String(value));
      return (
        <span className="property-view-value-date">
          {date.toLocaleDateString()}
        </span>
      );
    
    case 'selection':
      const option = property.options.find(o => o.name === value);
      return (
        <span className="property-view-value-selection">
          {option?.icon && <span className="property-view-value-icon">{option.icon}</span>}
          {String(value)}
        </span>
      );
    
    case 'node':
      // Node reference - would need to resolve the node name
      return (
        <span className="property-view-value-node">
          <NodeIcon icon={null} isPage={true} size="xs" />
          Node #{String(value)}
        </span>
      );
    
    case 'text':
    default:
      return (
        <span className="property-view-value-text">
          {String(value)}
        </span>
      );
  }
}

export default PropertyView;
