/**
 * PropertyConfigSection Component
 * 
 * A dedicated section on the property page for configuring property settings.
 * Uses the same layout as PropertyCreateModal via the shared PropertyForm component.
 * 
 * Features:
 * - Property name and icon editing
 * - Property type display (read-only)
 * - Scope display (read-only)
 * - Selection options management
 * - Delete property action
 */
import { useState, useCallback, useMemo } from 'react';
import type { Property, Node } from '@/types/api';
import { addSelectionOption, deleteSelectionOption } from '@/api/properties';
import { useDeleteProperty, useNodes } from '@/hooks';
import { Button } from '../core/Button';
import { Modal } from '../core/Modal';
import { PropertyForm } from './PropertyForm';
import { mdiTrashCan } from '@mdi/js';
import './PropertyConfigSection.css';

interface SelectionOptionWithId {
  id: string;
  name: string;
  icon?: string;
}

interface PropertyConfigSectionProps {
  property: Property;
  onUpdate: (property: Property) => void;
  onDelete?: (propertyId: number) => void;
}

export function PropertyConfigSection({
  property,
  onUpdate,
  onDelete,
}: PropertyConfigSectionProps) {
  // Form state (name and icon removed - they're in PageHeader now)
  const [isLocal] = useState(property.is_local || false);
  const [isMultiValue] = useState(false); // TODO: Get from property
  const [defaultValue] = useState(''); // TODO: Get from property
  const [newOptionName, setNewOptionName] = useState('');
  const [newOptionIcon, setNewOptionIcon] = useState('');
  const [showAddOption, setShowAddOption] = useState(false);
  const [allowedClasses] = useState<Node[]>([]); // TODO: Get from property
  const [showClassSelector, setShowClassSelector] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  
  // Mutations
  const deletePropertyMutation = useDeleteProperty();
  
  // Data
  const { data: allNodes } = useNodes();
  
  // Convert property options to form format
  const selectionOptions: SelectionOptionWithId[] = useMemo(() => 
    (property.options || []).map(opt => ({
      id: String(opt.id),
      name: opt.name,
      icon: opt.icon || undefined,
    })),
    [property.options]
  );
  
  // Get type classes for display
  const typeClasses = useMemo(() => 
    allNodes?.filter(n => n.is_class) || [],
    [allNodes]
  );
  
  // Selection option handlers
  const handleAddSelectionOption = useCallback(async () => {
    if (!newOptionName.trim()) return;
    
    try {
      const newOption = await addSelectionOption(
        property.id,
        newOptionName.trim(),
        newOptionIcon || null,
        null, // color
        property.options.length // sequence
      );
      
      // Update property with new option
      const updatedProperty: Property = {
        ...property,
        options: [...property.options, newOption],
      };
      onUpdate(updatedProperty);
      
      setNewOptionName('');
      setNewOptionIcon('');
      setShowAddOption(false);
      setError(null);
    } catch (err) {
      setError('Failed to add selection option');
      console.error(err);
    }
  }, [property, newOptionName, newOptionIcon, onUpdate]);
  
  const handleRemoveSelectionOption = useCallback(async (id: string) => {
    try {
      await deleteSelectionOption(property.id, Number(id));
      
      // Update property without the deleted option
      const updatedProperty: Property = {
        ...property,
        options: property.options.filter(o => String(o.id) !== id),
      };
      onUpdate(updatedProperty);
      setError(null);
    } catch (err) {
      setError('Failed to remove selection option');
      console.error(err);
    }
  }, [property, onUpdate]);
  
  const handleReorderSelectionOptions = useCallback((reordered: SelectionOptionWithId[]) => {
    // TODO: Call API to reorder options
    console.log('Reorder selection options:', reordered);
  }, []);
  
  // Allowed class handlers
  const handleAddAllowedClass = useCallback((node: Node) => {
    // TODO: Call API to add allowed class
    console.log('Add allowed class:', node);
    setShowClassSelector(false);
  }, []);
  
  const handleRemoveAllowedClass = useCallback((nodeId: string) => {
    // TODO: Call API to remove allowed class
    console.log('Remove allowed class:', nodeId);
  }, []);
  
  // Delete the property
  const handleDeleteClick = useCallback(() => {
    if (!onDelete) return;
    setShowDeleteModal(true);
  }, [onDelete]);

  const handleConfirmDelete = useCallback(async () => {
    if (!onDelete) return;
    
    try {
      await deletePropertyMutation.mutateAsync(property.id);
      onDelete(property.id);
      setShowDeleteModal(false);
    } catch (err) {
      setError('Failed to delete property');
      console.error(err);
      setShowDeleteModal(false);
    }
  }, [property, onDelete, deletePropertyMutation]);

  const handleCancelDelete = useCallback(() => {
    setShowDeleteModal(false);
  }, []);
  
  return (
    <div className="property-config-section">
      <PropertyForm
        icon=""
        onIconChange={() => {}}
        name={property.name}
        onNameChange={() => {}}
        propertyType={property.type}
        isLocal={isLocal}
        onIsLocalChange={() => {}}
        isMultiValue={isMultiValue}
        onIsMultiValueChange={() => {}}
        defaultValue={defaultValue}
        onDefaultValueChange={() => {}}
        selectionOptions={selectionOptions}
        onAddOption={handleAddSelectionOption}
        onRemoveOption={handleRemoveSelectionOption}
        onReorderOptions={(fromIndex, toIndex) => {
          const reordered = [...selectionOptions];
          const [moved] = reordered.splice(fromIndex, 1);
          reordered.splice(toIndex, 0, moved);
          handleReorderSelectionOptions(reordered);
        }}
        newOptionName={newOptionName}
        onNewOptionNameChange={setNewOptionName}
        newOptionIcon={newOptionIcon}
        onNewOptionIconChange={setNewOptionIcon}
        showAddOption={showAddOption}
        onShowAddOptionChange={setShowAddOption}
        allowedClasses={allowedClasses}
        onAddClass={handleAddAllowedClass}
        onRemoveClass={(id) => handleRemoveAllowedClass(String(id))}
        showClassSelector={showClassSelector}
        onShowClassSelectorChange={setShowClassSelector}
        typeClasses={typeClasses}
        showTypeSelection={false}
        showScopeSelection={false}
        showIconSelection={false}
        showNameField={false}
      />
      
      {error && (
        <div className="property-config-section__error">
          {error}
        </div>
      )}
      
      {onDelete && (
        <>
          <div className="property-config-section__delete">
            <Button
              onClick={handleDeleteClick}
              variant="ghost"
              icon={mdiTrashCan}
            >
              Delete Property
            </Button>
          </div>
          
          {showDeleteModal && (
            <Modal
              isOpen={showDeleteModal}
              title="Delete Property"
              onClose={handleCancelDelete}
              footer={
                <>
                  <Button onClick={handleCancelDelete}>Cancel</Button>
                  <Button 
                    onClick={handleConfirmDelete}
                    variant="danger"
                    disabled={deletePropertyMutation.isPending}
                  >
                    {deletePropertyMutation.isPending ? 'Deleting...' : 'Delete'}
                  </Button>
                </>
              }
            >
              <p>
                Are you sure you want to delete the property &quot;{property.name}&quot;?
                This will remove the property and all its values from all nodes.
              </p>
            </Modal>
          )}
        </>
      )}
    </div>
  );
}
