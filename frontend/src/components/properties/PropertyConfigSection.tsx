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
import { useDeleteProperty } from '@/hooks';
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
  const [isMultiValue, setIsMultiValue] = useState(property.multi || false);
  const [showMultiValueConfirm, setShowMultiValueConfirm] = useState(false);
  const [defaultValue] = useState(''); // TODO: Get from property
  const [newOptionName, setNewOptionName] = useState('');
  const [newOptionIcon, setNewOptionIcon] = useState('');
  const [showAddOption, setShowAddOption] = useState(false);
  const [allowedClasses] = useState<Node[]>([]); // TODO: Get from property
  const [error, setError] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  
  // Mutations
  const deletePropertyMutation = useDeleteProperty();
  const updatePropertyMutation = useUpdateProperty();
  
  // Convert property options to form format
  const selectionOptions: SelectionOptionWithId[] = useMemo(() => 
    (property.options || []).map(opt => ({
      id: String(opt.id),
      name: opt.name,
      icon: opt.icon || undefined,
    })),
    [property.options]
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
  }, []);
  
  const handleRemoveAllowedClass = useCallback((nodeId: number) => {
    // TODO: Call API to remove allowed class
    console.log('Remove allowed class:', nodeId);
  }, []);
  
  // Handle multi-value change
  const handleMultiValueChange = useCallback(async (newIsMulti: boolean) => {
    // If changing from multi to single, show confirmation
    if (isMultiValue && !newIsMulti) {
      setShowMultiValueConfirm(true);
    } else {
      // Changing from single to multi is safe, no confirmation needed
      try {
        const updated = await updatePropertyMutation.mutateAsync({
          id: property.id,
          data: { is_multi: newIsMulti },
        });
        setIsMultiValue(newIsMulti);
        onUpdate(updated);
        setError(null);
      } catch (err) {
        setError('Failed to update multi-value setting');
        console.error(err);
      }
    }
  }, [property, isMultiValue, updatePropertyMutation, onUpdate]);
  
  // Confirm multi-value to single-value change
  const handleConfirmMultiValueChange = useCallback(async () => {
    try {
      const updated = await updatePropertyMutation.mutateAsync({
        id: property.id,
        data: { is_multi: false },
      });
      setIsMultiValue(false);
      onUpdate(updated);
      setShowMultiValueConfirm(false);
      setError(null);
    } catch (err) {
      setError('Failed to update multi-value setting');
      console.error(err);
      setShowMultiValueConfirm(false);
    }
  }, [property, updatePropertyMutation, onUpdate]);
  
  const handleCancelMultiValueChange = useCallback(() => {
    setShowMultiValueConfirm(false);
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
      {/* Scope Display (for local properties only) */}
      {property.is_local && property.node_id && (
        <div className="property-config-section__scope">
          <span className="property-config-section__scope-label">Applies to </span>
          <a 
            href="#" 
            className="property-config-section__scope-link"
            onClick={(e) => {
              e.preventDefault();
              // TODO: Navigate to node
              console.log('Navigate to node:', property.node_id);
            }}
          >
            Page #{property.node_id}
          </a>
        </div>
      )}
      
      <PropertyForm
        icon=""
        onIconChange={() => {}}
        name={property.name}
        onNameChange={() => {}}
        propertyType={property.type}
        isLocal={isLocal}
        onIsLocalChange={() => {}}
        isMultiValue={isMultiValue}
        onIsMultiValueChange={handleMultiValueChange}
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
        onRemoveClass={handleRemoveAllowedClass}
        showTypeSelection={false}
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
      
      {/* Multi-value Change Confirmation Modal */}
      {showMultiValueConfirm && (
        <Modal
          isOpen={showMultiValueConfirm}
          title="Change to Single Value"
          onClose={handleCancelMultiValueChange}
          footer={
            <>
              <Button onClick={handleCancelMultiValueChange}>Cancel</Button>
              <Button 
                onClick={handleConfirmMultiValueChange}
                variant="danger"
                disabled={updatePropertyMutation.isPending}
              >
                {updatePropertyMutation.isPending ? 'Changing...' : 'Change to Single Value'}
              </Button>
            </>
          }
        >
          <p>
            Changing this property to single-value will <strong>delete all extra values</strong> and keep only the first value for each node.
          </p>
          <p>
            This action cannot be undone. Are you sure you want to continue?
          </p>
        </Modal>
      )}
    </div>
  );
}
