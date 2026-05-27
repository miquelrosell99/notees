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
import { useState, useEffect, useMemo, useCallback } from 'react';
import { Spinner } from '@/components/core/Spinner';
import type { Property, Node, PropertyType } from '@/types/api';
import type { QueryAST, QueryPropertyType } from '@/types/queryAST';
import { useProperty, useDeleteProperty, useUpdateProperty } from '@/hooks';
import { useNavigationStore } from '@/stores';
import { createEmptyQueryAST, createPropertyCondition, markAsSystemNode } from '@/types/queryAST';
import { MainContentTopbar } from '../components/layout/MainContentTopbar';
import { QuerySection } from '../components/nodes/QuerySection';
import { PropertyConfigSection } from '../components/properties/PropertyConfigSection';
import { PageHeader } from '../components/nodes/PageHeader';
import { ContextMenu, type ContextMenuItem } from '../components/core/ContextMenu';
import { ConfirmationModal } from '../components/core/ConfirmationModal';
import { ToggleSwitch } from '../components/core/ToggleSwitch';
import { Button } from '../components/core/Button';
import './PropertyView.css';

/** Map api.ts PropertyType to queryAST.ts QueryPropertyType */
function toQueryPropertyType(type: PropertyType): QueryPropertyType {
  switch (type) {
    case 'integer':
    case 'float': return 'number';
    case 'boolean': return 'checkbox';
    case 'selection': return 'select';
    default: return type as QueryPropertyType;
  }
}

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
}: PropertyViewProps): PropertyViewResult {
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [propertyQueryAST, setPropertyQueryAST] = useState<QueryAST | undefined>(undefined);
  
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
  const { openNode } = useNavigationStore();
  const deletePropertyMutation = useDeleteProperty();
  const updatePropertyMutation = useUpdateProperty();
  
  // Build/reset query AST whenever the property UUID changes
  useEffect(() => {
    if (!property) return;
    const ast = createEmptyQueryAST();
    ast.scope.scope_type = 'entire_workspace';
    ast.root_group.children.push(
      markAsSystemNode(createPropertyCondition(property.name, 'is_not_empty', undefined, toQueryPropertyType(property.type), property.uuid))
    );
    setPropertyQueryAST(ast);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [property?.uuid]);
  
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
  
  const typeInfo = property ? PROPERTY_TYPES[property.type] : null;
  const isLoading = propertyLoading;
  
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

  if (isLoading && !property) {
    return {
      header: <MainContentTopbar />,
      content: (
        <div className="property-view loading">
          <Spinner size="md" label="Loading property..." centered />
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
            icon={"mdi mdi-delete"}
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
    <main className="main-content">
      <div className="property-view">
      {/* Property Header - using PageHeader for consistency */}
        <div className="page-header-section">
          <div className="page-header-section__header">
            <PageHeader
              page={property as unknown as Node}
              onContextMenu={handleContextMenu}
              onNameChange={handlePropertyNameChange}
              onIconChange={handlePropertyIconChange}
            />
          </div>
        </div>
      
      
      {/* Property Configuration Section */}
      <PropertyConfigSection
        property={property}
        onUpdate={handlePropertyUpdate}
      />
      
      {/* Nodes with this property */}
      <QuerySection
        nodeId={0}
        nodeUuid="00000000-0000-0000-0000-000000000000"
        viewType="inline"
        title={`Nodes with "${property.name}"`}
        hideWhenEmpty={false}
        defaultExpanded={true}
        queryAST={propertyQueryAST}
        onQueryASTChange={setPropertyQueryAST}
        onNodeClick={(nodeId) => onNavigateToNode?.(nodeId)}
        can_create={false}
      />
      
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
  const { header, content: _content } = PropertyView(props);
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
