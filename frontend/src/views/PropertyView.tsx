/**
 * PropertyView Component
 * 
 * A dedicated view for displaying all nodes that have a specific property set.
 * Shows the property information at the top and a NodeCollection table of all nodes with values.
 * 
 * Features:
 * - Property header with icon, name, type info (using PageHeader component)
 * - NodeCollection table with property value as a column (wrapped in NodeViewSection)
 * - Navigation to nodes on click
 * - Delete property action in context menu
 */
import { useState, useMemo, useCallback, type ReactNode } from 'react';
import type { Property, Node } from '@/types/api';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import { useProperty, useNodesWithProperty, useDeleteProperty, useUpdateProperty } from '@/hooks';
import { useNodesStore } from '@/stores';
import { NodeCollection } from '../components/nodes/NodeCollection';
import { NodeCollectionToolbar } from '../components/nodes/NodeCollectionToolbar';
import { NodeIcon } from '../components/icons';
import { PropertyConfigSection } from '../components/properties/PropertyConfigSection';
import { PageHeader } from '../components/PageHeader';
import { NodeViewSection } from '../components/nodes/NodeViewSection';
import { ContextMenu, type ContextMenuItem } from '../components/core/ContextMenu';
import { ConfirmationModal } from '../components/core/ConfirmationModal';
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
  /** Navigate to a node */
  onNavigateToNode?: (nodeId: number) => void;
  /** Open a node in sidebar */
  onOpenInSidebar?: (nodeId: number) => void;
}

export function PropertyView({
  propertyId,
  onNavigateToNode,
  onOpenInSidebar,
}: PropertyViewProps) {
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('table');
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  
  // Fetch property details
  const { data: fetchedProperty, isLoading: propertyLoading } = useProperty(propertyId);
  
  // Local property state for optimistic updates
  const [property, setProperty] = useState<Property | undefined>(fetchedProperty);
  
  // Update local state when fetched property changes
  useMemo(() => {
    if (fetchedProperty) {
      setProperty(fetchedProperty);
    }
  }, [fetchedProperty]);
  
  // Handle property updates
  const handlePropertyUpdate = useCallback((updatedProperty: Property) => {
    setProperty(updatedProperty);
  }, []);
  
  // Get navigation function
  const { openNode } = useNodesStore();
  const deletePropertyMutation = useDeleteProperty();
  const updatePropertyMutation = useUpdateProperty();
  
  // Handle property name change
  const handlePropertyNameChange = useCallback(async (name: string) => {
    if (!property || name === property.name) return;
    
    try {
      const updated = await updatePropertyMutation.mutateAsync({
        id: property.id,
        data: { name },
      });
      setProperty(updated);
    } catch (err) {
      console.error('Failed to update property name:', err);
    }
  }, [property, updatePropertyMutation]);
  
  // Handle property icon change
  const handlePropertyIconChange = useCallback(async (icon: string) => {
    if (!property) return;
    
    try {
      const updated = await updatePropertyMutation.mutateAsync({
        id: property.id,
        data: { icon: icon || undefined },
      });
      setProperty(updated);
    } catch (err) {
      console.error('Failed to update property icon:', err);
    }
  }, [property, updatePropertyMutation]);
  
  // Handle property deletion
  const handlePropertyDelete = useCallback(async () => {
    if (!property) return;
    
    try {
      await deletePropertyMutation.mutateAsync(property.id);
      // Navigate to home or a default page after deletion
      openNode(1, 'page'); // Navigate to a safe page
    } catch (err) {
      console.error('Failed to delete property:', err);
    }
  }, [property, deletePropertyMutation, openNode]);
  
  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  }, []);
  
  const handleCloseContextMenu = useCallback(() => {
    setShowContextMenu(false);
  }, []);
  
  const handleDeleteClick = useCallback(() => {
    setShowDeleteModal(true);
  }, []);
  
  const handleConfirmDelete = useCallback(() => {
    handlePropertyDelete();
    setShowDeleteModal(false);
    setShowContextMenu(false);
  }, [handlePropertyDelete]);
  
  const handleCancelDelete = useCallback(() => {
    setShowDeleteModal(false);
  }, []);
  
  // Fetch nodes with this property using property ID
  const { data: nodesWithProperty, isLoading: nodesLoading } = useNodesWithProperty(
    property ? propertyId : null
  );
  
  // Generate columns for the table view
  const columns = useMemo<{ key: string; label: string; width?: string; render?: (node: Node) => ReactNode }[]>(() => {
    if (!property) return [];
    
    return [
      {
        key: 'name',
        label: 'Name',
        width: '40%',
      },
      {
        key: property.name.toLowerCase().replace(/\s+/g, '_'),
        label: property.name,
        width: '40%',
        render: (node: Node) => {
          const propKey = property.name.toLowerCase().replace(/\s+/g, '_');
          const value = (node.properties as Record<string, unknown>)?.[propKey];
          return <PropertyValueDisplay property={property} value={value} />;
        },
      },
      {
        key: 'updated',
        label: 'Updated',
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
  
  // Handle node click
  const handleNodeClick = (node: Node) => {
    onNavigateToNode?.(node.id);
  };
  
  // Handle shift+click (open in sidebar)
  const handleNodeShiftClick = (node: Node) => {
    onOpenInSidebar?.(node.id);
  };
  
  // Build context menu items
  const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!property) return [];
    
    return [
      {
        id: 'delete-property',
        label: 'Delete Property',
        danger: true,
        keepOpen: true,
        onClick: handleDeleteClick
      }
    ];
  }, [property, handleDeleteClick]);
  
  const isLoading = propertyLoading || nodesLoading;
  const typeInfo = property ? PROPERTY_TYPES[property.type] : null;
  const nodes = nodesWithProperty ?? [];
  
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
      {/* Property Header - using PageHeader for consistency */}
      <div className="page-header-section">
        <div className="page-header-section__header">
          <PageHeader
            page={property as unknown as Node}
            compactMode={false}
            onContextMenu={handleContextMenu}
            onNameChange={handlePropertyNameChange}
            onIconChange={handlePropertyIconChange}
          />
        </div>
      </div>
      
      {/* Property Type and Meta Info */}
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
        {property.is_local ? (
          <span className="property-view-badge">📍 Local</span>
        ) : (
          <span className="property-view-badge">🌐 Global</span>
        )}
      </div>
      
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
      
      {/* Property Configuration Section */}
      <PropertyConfigSection
        property={property}
        onUpdate={handlePropertyUpdate}
      />
      
      {/* Nodes with this property */}
      <NodeViewSection
        title={`Nodes with "${property.name}"`}
        count={nodes.length}
        defaultExpanded={true}
        headerActions={
          nodes.length > 0 && !nodesLoading ? (
            <NodeCollectionToolbar
              viewMode={viewMode}
              availableViewModes={['table', 'list', 'card']}
              onViewModeChange={setViewMode}
              hideToolbarControls={false}
            />
          ) : undefined
        }
      >
        {nodesLoading ? (
          <div className="property-view-loading">Loading nodes...</div>
        ) : nodes.length === 0 ? (
          <div className="property-view-empty">
            No nodes have the "{property.name}" property set.
          </div>
        ) : (
          <NodeCollection
            nodes={nodes}
            viewMode={viewMode}
            availableViewModes={['table', 'list', 'card']}
            onViewModeChange={setViewMode}
            editable={false}
            showClasses={true}
            onNodeClick={handleNodeClick}
            onNodeShiftClick={handleNodeShiftClick}
            tableColumns={columns}
            hideToolbar={true}
          />
        )}
      </NodeViewSection>
      
      {/* Context Menu */}
      {showContextMenu && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenuPos}
          onClose={handleCloseContextMenu}
        />
      )}
      
      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
        <ConfirmationModal
          isOpen={showDeleteModal}
          title="Delete Property"
          message={`Are you sure you want to delete the property "${property.name}"? This will remove the property and all its values from all nodes.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          variant="danger"
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      )}
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
    
    case 'date': {
      const date = new Date(String(value));
      return (
        <span className="property-view-value-date">
          {date.toLocaleDateString()}
        </span>
      );
    }
    
    case 'selection': {
      const option = property.options.find(o => o.name === value);
      return (
        <span className="property-view-value-selection">
          {option?.icon && <span className="property-view-value-icon">{option.icon}</span>}
          {String(value)}
        </span>
      );
    }
    
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
