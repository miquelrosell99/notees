/**
 * PropertyView Component
 * 
 * A dedicated view for displaying all nodes that have a specific property set.
 * Shows the property information at the top and a NodeCollection table of all nodes with values.
 * 
 * Features:
 * - Property header with icon, name, type info (using PageHeader component)
 * - Topbar with mode toggle, type indicator, and delete button
 * - NodeCollection table with property value as a column (wrapped in NodeViewSection)
 * - Navigation to nodes on click
 * - Delete property action in context menu
 */
import { useState, useMemo, useCallback } from 'react';
import { mdiDelete } from '@mdi/js';
import type { Property, Node } from '@/types/api';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import { useProperty, useNodesWithProperty, useDeleteProperty, useUpdateProperty } from '@/hooks';
import { useAppStore } from '@/stores';
import { MainContentTopbar } from '../components/layout/MainContentTopbar';
import { NodeCollection } from '../components/nodes/NodeCollection';
import { NodeCollectionToolbar } from '../components/nodes/NodeCollectionToolbar';
import { PropertyConfigSection } from '../components/properties/PropertyConfigSection';
import { PageHeader } from '../components/nodes/PageHeader';
import { NodeViewSection } from '../components/nodes/NodeViewSection';
import { ContextMenu, type ContextMenuItem } from '../components/core/ContextMenu';
import { ConfirmationModal } from '../components/core/ConfirmationModal';
import { ToggleSwitch } from '../components/core/ToggleSwitch';
import { Button } from '../components/core/Button';
import './PropertyView.css';

/** Property type display info */
const PROPERTY_TYPES: Record<string, { label: string; icon: string; supportsMulti: boolean }> = {
  text: { label: 'Text', icon: '', supportsMulti: true },
  integer: { label: 'Number', icon: '', supportsMulti: false },
  float: { label: 'Decimal', icon: '', supportsMulti: false },
  boolean: { label: 'Checkbox', icon: '', supportsMulti: false },
  date: { label: 'Date', icon: '', supportsMulti: false },
  selection: { label: 'Selection', icon: '', supportsMulti: true },
  node: { label: 'Node', icon: '', supportsMulti: true },
};

interface PropertyViewProps {
  /** Property ID to display */
  propertyId: number;
  /** Navigate to a node */
  onNavigateToNode?: (nodeId: number) => void;
  /** Open a node in sidebar */
  onOpenInSidebar?: (nodeId: number) => void;
}

export interface PropertyViewResult {
  header: React.ReactNode;
  content: React.ReactNode;
}

export function PropertyView({
  propertyId,
  onNavigateToNode,
  onOpenInSidebar,
}: PropertyViewProps): PropertyViewResult {
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
  const { openNode } = useAppStore();
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
  
  // Handle multi-value toggle change
  const handleMultiChange = useCallback(async (multi: boolean) => {
    if (!property) return;
    
    try {
      const updated = await updatePropertyMutation.mutateAsync({
        id: property.id,
        data: { multi },
      });
      setProperty(updated);
    } catch (err) {
      console.error('Failed to update property multi setting:', err);
    }
  }, [property, updatePropertyMutation]);
  
  // Handle property deletion
  const handlePropertyDelete = useCallback(async () => {
    if (!property) return;
    
    try {
      await deletePropertyMutation.mutateAsync(property.id);
      // Navigate to home or a default page after deletion
      openNode(1); // Navigate to a safe page
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
  
  // Property column UUIDs for the table view
  // Default: show only the current property column
  const [selectedPropertyUuids, setSelectedPropertyUuids] = useState<string[]>(
    property ? [property.uuid] : []
  );
  
  // Update property UUIDs when property changes
  useMemo(() => {
    if (property) {
      setSelectedPropertyUuids(prev => {
        // Ensure current property UUID is always included
        if (!prev.includes(property.uuid)) {
          return [property.uuid, ...prev];
        }
        return prev;
      });
    }
  }, [property]);
  
  const handlePropertyColumnsChange = useCallback((uuids: string[]) => {
    setSelectedPropertyUuids(uuids);
  }, []);
  
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
    return {
      header: <MainContentTopbar />,
      content: (
        <div className="property-view loading">
          <div className="property-view-skeleton">Loading property...</div>
        </div>
      )
    };
  }
  
  if (!property) {
    return {
      header: <MainContentTopbar />,
      content: (
        <div className="property-view error">
          <p>Property not found</p>
        </div>
      )
    };
  }
  
  const headerContent = (
    <MainContentTopbar
      left={
        <div className="property-view__type-badge">
          {typeInfo?.label.toUpperCase() || property.type.toUpperCase()}
        </div>
      }
      right={
        <>
          {typeInfo?.supportsMulti && (
            <ToggleSwitch
              leftLabel="SINGLE"
              rightLabel="MULTI"
              checked={property.multi}
              onChange={handleMultiChange}
              size="sm"
            />
          )}
          <Button
            icon={mdiDelete}
            variant="ghost"
            size="sm"
            onClick={handleDeleteClick}
            title="Delete property"
            aria-label="Delete property"
          />
        </>
      }
    />
  );

  const mainContent = (
    <main className="main-content property-view">
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
        onDelete={() => openNode(1)}
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
              selectedPropertyUuids={selectedPropertyUuids}
              onPropertyColumnsChange={handlePropertyColumnsChange}
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
            editable={true}
            showClasses={true}
            onNodeShiftClick={handleNodeShiftClick}
            selectedPropertyUuids={selectedPropertyUuids}
            onPropertyColumnsChange={handlePropertyColumnsChange}
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
      </main>
  );

  return {
    header: headerContent,
    content: mainContent
  };
}

/**
 * PropertyViewWrapper - React component wrapper for PropertyView function
 * Renders header as fixed bar and content in scrollable area
 */
export function PropertyViewWrapper(props: PropertyViewProps) {
  const { header, content } = PropertyView(props);
  return header;
}

/**
 * PropertyViewContent - Renders just the content portion
 */
export function PropertyViewContent(props: PropertyViewProps) {
  const { content } = PropertyView(props);
  return content;
}

/**
 * PropertyViewFull - Renders both header and content from a single PropertyView call
 * so that all state (e.g. delete modal) is shared between header and content.
 */
export function PropertyViewFull(props: PropertyViewProps) {
  const { header, content } = PropertyView(props);
  return (
    <>
      {header}
      {content}
    </>
  );
}

export default PropertyView;
