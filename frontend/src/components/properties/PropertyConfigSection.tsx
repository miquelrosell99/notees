/**
 * PropertyConfigSection Component
 * 
 * A dedicated section on the property page for configuring property settings.
 * Similar in style to ClassPropertiesEditor with Card component and expandable sections.
 * 
 * Features:
 * - Property name and icon editing
 * - Property type display
 * - Default value configuration (future)
 * - Selection options management
 * - Delete property action
 */
import { useState, useCallback } from 'react';
import type { Property, PropertyType, SelectionOption } from '@/types/api';
import { updateProperty, addSelectionOption, deleteSelectionOption } from '@/api/properties';
import { useDeleteProperty } from '@/hooks';
import { EmojiPickerTrigger } from '../core/EmojiPicker';
import { Button } from '../core/Button';
import { Card } from '../core/Card';
import { ConfirmationModal } from '../core/ConfirmationModal';
import { ChevronRightIcon } from '../icons';
import './PropertyConfigSection.css';

/** Property type display info */
const PROPERTY_TYPES: { type: PropertyType; label: string; icon: string }[] = [
  { type: 'text', label: 'Text', icon: '' },
  { type: 'integer', label: 'Number', icon: '' },
  { type: 'float', label: 'Decimal', icon: '' },
  { type: 'boolean', label: 'Checkbox', icon: '' },
  { type: 'date', label: 'Date', icon: '' },
  { type: 'selection', label: 'Selection', icon: '' },
  { type: 'node', label: 'Node', icon: '' },
];

interface PropertyConfigSectionProps {
  property: Property;
  onUpdate: (property: Property) => void;
  onDelete?: (propertyId: number) => void;
}

interface SectionState {
  name: boolean;
  description: boolean;
  type: boolean;
  defaultValue: boolean;
  choices: boolean;
  addChoice: boolean;
  deleteProperty: boolean;
}

export function PropertyConfigSection({
  property,
  onUpdate,
  onDelete,
}: PropertyConfigSectionProps) {
  // Form state
  const [name, setName] = useState(property.name);
  const [icon, setIcon] = useState(property.icon || '');
  // const [description, setDescription] = useState(property.description || ''); // For future use
  const [newChoiceName, setNewChoiceName] = useState('');
  const [newChoiceIcon, setNewChoiceIcon] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  
  // Mutation for deleting property
  const deletePropertyMutation = useDeleteProperty();
  
  // Section expansion state
  const [sections, setSections] = useState<SectionState>({
    name: false,
    description: false,
    type: false,
    defaultValue: false,
    choices: false,
    addChoice: false,
    deleteProperty: false,
  });
  
  // Toggle section expansion
  const toggleSection = useCallback((section: keyof SectionState) => {
    setSections(prev => ({ ...prev, [section]: !prev[section] }));
  }, []);
  
  // Save property name/icon
  const handleSaveName = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Property name is required');
      return;
    }
    
    const updates: { name?: string; icon?: string } = {};
    if (trimmedName !== property.name) {
      updates.name = trimmedName;
    }
    if (icon !== (property.icon || '')) {
      updates.icon = icon || undefined;
    }
    
    if (Object.keys(updates).length > 0) {
      try {
        const updated = await updateProperty(property.id, updates);
        onUpdate(updated);
        setError(null);
      } catch (err) {
        setError('Failed to update property');
        console.error(err);
      }
    }
    
    toggleSection('name');
  }, [property, name, icon, onUpdate, toggleSection]);
  
  // Add a new choice
  const handleAddChoice = useCallback(async () => {
    if (property.type !== 'selection') return;
    
    const trimmedName = newChoiceName.trim();
    if (!trimmedName) {
      setError('Choice name is required');
      return;
    }
    
    try {
      const newOption = await addSelectionOption(
        property.id,
        trimmedName,
        newChoiceIcon || null,
        null, // color
        property.options.length // sequence
      );
      
      // Update property with new option
      const updatedProperty: Property = {
        ...property,
        options: [...property.options, newOption],
      };
      onUpdate(updatedProperty);
      
      setNewChoiceName('');
      setNewChoiceIcon('');
      setError(null);
      toggleSection('addChoice');
    } catch (err) {
      setError('Failed to add choice');
      console.error(err);
    }
  }, [property, newChoiceName, newChoiceIcon, onUpdate, toggleSection]);
  
  // Delete a choice
  const handleDeleteChoice = useCallback(async (option: SelectionOption) => {
    try {
      await deleteSelectionOption(property.id, option.id);
      
      // Update property without the deleted option
      const updatedProperty: Property = {
        ...property,
        options: property.options.filter(o => o.id !== option.id),
      };
      onUpdate(updatedProperty);
      setError(null);
    } catch (err) {
      setError('Failed to delete choice');
      console.error(err);
    }
  }, [property, onUpdate]);
  
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
  
  const typeInfo = PROPERTY_TYPES.find(t => t.type === property.type);
  
  return (
    <Card 
      variant="dashed" 
      elevation="none" 
      radius="lg" 
      paddingSize="lg"
      className="property-config-section"
    >
      <h3 className="property-config-section__title">Property Configuration</h3>
      
      {error && (
        <div className="property-config-section__error">{error}</div>
      )}
      
      {/* Property name section */}
      <div className="property-config-section__item">
        <button
          className={`property-config-section__header ${sections.name ? 'expanded' : ''}`}
          onClick={() => toggleSection('name')}
        >
          <ChevronRightIcon size="xs" />
          <span className="property-config-section__label">Property name</span>
          <span className="property-config-section__value">
            {property.icon && <span className="property-config-section__icon">{property.icon}</span>}
            {property.name}
          </span>
        </button>
        
        {sections.name && (
          <div className="property-config-section__content">
            <div className="property-config-section__field">
              <label className="property-config-section__field-label">Name</label>
              <input
                type="text"
                className="property-config-section__input"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                placeholder="Property name"
              />
            </div>
            
            <div className="property-config-section__field">
              <label className="property-config-section__field-label">Icon</label>
              <EmojiPickerTrigger
                value={icon}
                onSelect={setIcon}
                placeholder="Add icon"
              />
            </div>
            
            <div className="property-config-section__actions">
              <Button variant="default" size="sm" onClick={() => toggleSection('name')}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={handleSaveName}>
                Save
              </Button>
            </div>
          </div>
        )}
      </div>
      
      {/* Property type section */}
      <div className="property-config-section__item">
        <button
          className="property-config-section__header"
          onClick={() => toggleSection('type')}
        >
          <ChevronRightIcon size="xs" />
          <span className="property-config-section__label">Property type</span>
          <span className="property-config-section__value">
            {typeInfo && <span className="property-config-section__icon">{typeInfo.icon}</span>}
            {typeInfo?.label || property.type}
          </span>
        </button>
        
        {sections.type && (
          <div className="property-config-section__content">
            <p className="property-config-section__hint">
              Property type cannot be changed after creation.
            </p>
          </div>
        )}
      </div>
      
      {/* Available choices section (for selection type) */}
      {property.type === 'selection' && (
        <div className="property-config-section__item">
          <button
            className={`property-config-section__header ${sections.choices ? 'expanded' : ''}`}
            onClick={() => toggleSection('choices')}
          >
            <ChevronRightIcon size="xs" />
            <span className="property-config-section__label">Available choices</span>
            <span className="property-config-section__value">
              {property.options.length} choice{property.options.length !== 1 ? 's' : ''}
            </span>
          </button>
          
          {sections.choices && (
            <div className="property-config-section__content">
              {/* Existing choices */}
              <div className="property-config-section__choices">
                {property.options.map(option => (
                  <div key={option.id} className="property-config-section__choice">
                    <span className="property-config-section__choice-icon">
                      {option.icon || '○'}
                    </span>
                    <span className="property-config-section__choice-name">{option.name}</span>
                    <button
                      className="property-config-section__choice-delete"
                      onClick={() => handleDeleteChoice(option)}
                      title="Delete choice"
                    >
                      ×
                    </button>
                  </div>
                ))}
                
                {property.options.length === 0 && (
                  <p className="property-config-section__empty">No choices defined yet.</p>
                )}
              </div>
              
              {/* Add choice sub-section */}
              <div className="property-config-section__subsection">
                <button
                  className={`property-config-section__header ${sections.addChoice ? 'expanded' : ''}`}
                  onClick={() => toggleSection('addChoice')}
                >
                  <ChevronRightIcon size="xs" />
                  <span className="property-config-section__label">Add choice</span>
                </button>
                
                {sections.addChoice && (
                  <div className="property-config-section__content">
                    <div className="property-config-section__field">
                      <label className="property-config-section__field-label">Name</label>
                      <input
                        type="text"
                        className="property-config-section__input"
                        value={newChoiceName}
                        onChange={(e) => setNewChoiceName(e.target.value)}
                        placeholder="Choice name"
                      />
                    </div>
                    
                    <div className="property-config-section__field">
                      <label className="property-config-section__field-label">Icon (optional)</label>
                      <EmojiPickerTrigger
                        value={newChoiceIcon}
                        onSelect={setNewChoiceIcon}
                        placeholder="Add icon"
                      />
                    </div>
                    
                    <div className="property-config-section__actions">
                      <Button variant="default" size="sm" onClick={() => toggleSection('addChoice')}>
                        Cancel
                      </Button>
                      <Button variant="primary" size="sm" onClick={handleAddChoice}>
                        Add
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      
      {/* Property scope section - read-only indicator */}
      <div className="property-config-section__item">
        <div className="property-config-section__header property-config-section__header--readonly">
          <span className="property-config-section__label">Scope</span>
          <span className="property-config-section__value">
            <span className="property-config-section__badge" data-scope={property.is_local ? 'local' : 'global'}>
              {property.is_local ? '📍 Local' : '🌐 Global'}
            </span>
          </span>
        </div>
        <p className="property-config-section__hint">
          {property.is_local 
            ? 'This property is local - only available for specific nodes and their typed nodes.'
            : 'This property is global - available for any node with a unique name.'
          }
        </p>
      </div>
      
      {/* Delete property section */}
      {!property.is_system && onDelete && (
        <div className="property-config-section__item">
          <Button 
            variant="ghost" 
            className="property-config-section__delete-btn" 
            onClick={handleDeleteClick}
          >
            Delete property from database
          </Button>
          <p className="property-config-section__hint property-config-section__hint--warning">
            This action cannot be undone and will remove all values of this property from all nodes.
          </p>
        </div>
      )}
      
      {property.is_system && (
        <p className="property-config-section__hint property-config-section__hint--info">
          This is a system property and cannot be deleted.
        </p>
      )}
      
      <ConfirmationModal
        isOpen={showDeleteModal}
        title="Delete Property"
        message={`Are you sure you want to delete the property "${property.name}"? This action cannot be undone and will remove all values of this property from all nodes.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </Card>
  );
}

export default PropertyConfigSection;
