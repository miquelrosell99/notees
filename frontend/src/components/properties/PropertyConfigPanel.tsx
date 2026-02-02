/**
 * PropertyConfigPanel Component
 * 
 * A comprehensive panel for configuring property settings, with expandable sections.
 * Replaces the simple PropertyEditModal with a more feature-rich UI.
 * 
 * Panels:
 * - Property name (with description sub-panel)
 * - Property type
 * - Default value
 * - Available choices (for selection type)
 * - Hide options
 * - Actions (delete, go to property page)
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import type { Property, PropertyType, SelectionOption } from '@/types/api';
import { updateProperty, addSelectionOption, deleteSelectionOption, deleteProperty } from '@/api/properties';
import { EmojiPickerTrigger } from '../core/EmojiPicker';
import { Button } from '../core/Button';
import { ConfirmationModal } from '../core/ConfirmationModal';
import './PropertyConfigPanel.css';

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

interface PropertyConfigPanelProps {
  isOpen: boolean;
  property: Property | null;
  position?: { x: number; y: number };
  onClose: () => void;
  onUpdate: (property: Property) => void;
  onDelete?: (propertyId: number) => void;
  onOpenPropertyView?: (propertyId: number) => void;
}

interface PanelState {
  name: boolean;
  description: boolean;
  type: boolean;
  defaultValue: boolean;
  choices: boolean;
  addChoice: boolean;
  hideOptions: boolean;
}

export function PropertyConfigPanel({
  isOpen,
  property,
  position,
  onClose,
  onUpdate,
  onDelete,
  onOpenPropertyView,
}: PropertyConfigPanelProps) {
  // Form state
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [description, setDescription] = useState('');
  const [newChoiceName, setNewChoiceName] = useState('');
  const [newChoiceIcon, setNewChoiceIcon] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  
  // Panel expansion state
  const [panels, setPanels] = useState<PanelState>({
    name: false,
    description: false,
    type: false,
    defaultValue: false,
    choices: false,
    addChoice: false,
    hideOptions: false,
  });
  
  const panelRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  
  // Initialize form when property changes
  useEffect(() => {
    if (isOpen && property) {
      setName(property.name);
      setIcon(property.icon || '');
      setDescription(property.description || '');
      setNewChoiceName('');
      setNewChoiceIcon('');
      setError(null);
      // Reset panels
      setPanels({
        name: false,
        description: false,
        type: false,
        defaultValue: false,
        choices: false,
        addChoice: false,
        hideOptions: false,
      });
    }
  }, [isOpen, property]);
  
  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);
  
  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);
  
  // Toggle panel expansion
  const togglePanel = useCallback((panel: keyof PanelState) => {
    setPanels(prev => ({ ...prev, [panel]: !prev[panel] }));
  }, []);
  
  // Save property name/icon
  const handleSaveName = useCallback(async () => {
    if (!property) return;
    
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
      } catch (err) {
        setError('Failed to update property');
        console.error(err);
      }
    }
    
    togglePanel('name');
  }, [property, name, icon, onUpdate, togglePanel]);
  
  // Add a new choice
  const handleAddChoice = useCallback(async () => {
    if (!property || property.type !== 'selection') return;
    
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
      togglePanel('addChoice');
    } catch (err) {
      setError('Failed to add choice');
      console.error(err);
    }
  }, [property, newChoiceName, newChoiceIcon, onUpdate, togglePanel]);
  
  // Delete a choice
  const handleDeleteChoice = useCallback(async (option: SelectionOption) => {
    if (!property) return;
    
    try {
      await deleteSelectionOption(property.id, option.id);
      
      // Update property without the deleted option
      const updatedProperty: Property = {
        ...property,
        options: property.options.filter(o => o.id !== option.id),
      };
      onUpdate(updatedProperty);
    } catch (err) {
      setError('Failed to delete choice');
      console.error(err);
    }
  }, [property, onUpdate]);
  
  // Delete the property
  const handleDeleteClick = useCallback(() => {
    if (!property || !onDelete) return;
    setShowDeleteModal(true);
  }, [property, onDelete]);

  const handleConfirmDelete = useCallback(async () => {
    if (!property || !onDelete) return;
    
    try {
      await deleteProperty(property.id);
      onDelete(property.id);
      setShowDeleteModal(false);
      onClose();
    } catch (err) {
      setError('Failed to delete property');
      console.error(err);
      setShowDeleteModal(false);
    }
  }, [property, onDelete, onClose]);

  const handleCancelDelete = useCallback(() => {
    setShowDeleteModal(false);
  }, []);
  
  // Go to property view
  const handleGoToProperty = useCallback(() => {
    if (!property || !onOpenPropertyView) return;
    onOpenPropertyView(property.id);
    onClose();
  }, [property, onOpenPropertyView, onClose]);
  
  if (!isOpen || !property) return null;
  
  const typeInfo = PROPERTY_TYPES.find(t => t.type === property.type);
  
  // Calculate panel position
  const style: React.CSSProperties = position
    ? {
        position: 'fixed',
        left: position.x,
        top: position.y,
      }
    : {};
  
  return (
    <div className="property-config-backdrop">
      <div className="property-config-panel" ref={panelRef} style={style}>
        {/* Property name section */}
        <div className="config-section">
          <button
            className={`config-section-header ${panels.name ? 'expanded' : ''}`}
            onClick={() => togglePanel('name')}
          >
            <span className="config-section-icon">▶</span>
            <span className="config-section-label">Property name</span>
            <span className="config-section-value">
              {property.icon && <span className="config-value-icon">{property.icon}</span>}
              {property.name}
            </span>
          </button>
          
          {panels.name && (
            <div className="config-section-content">
              <div className="config-field">
                <label className="config-label">Name</label>
                <input
                  ref={nameInputRef}
                  type="text"
                  className="config-input"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(null);
                  }}
                  placeholder="Property name"
                />
              </div>
              
              <div className="config-field">
                <label className="config-label">Icon</label>
                <EmojiPickerTrigger
                  value={icon}
                  onSelect={setIcon}
                  placeholder="Add icon"
                  className="config-icon-trigger"
                />
              </div>
              
              {error && <span className="config-error">{error}</span>}
              
              <div className="config-actions">
                <Button variant="default" size="sm" className="config-btn" onClick={() => togglePanel('name')}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" className="config-btn" onClick={handleSaveName}>
                  Save
                </Button>
              </div>
              
              {/* Description sub-section */}
              <div className="config-subsection">
                <button
                  className={`config-subsection-header ${panels.description ? 'expanded' : ''}`}
                  onClick={() => togglePanel('description')}
                >
                  <span className="config-section-icon">▶</span>
                  <span className="config-subsection-label">Description</span>
                </button>
                
                {panels.description && (
                  <div className="config-subsection-content">
                    <textarea
                      className="config-textarea"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Add a description for this property..."
                      rows={3}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        
        {/* Property type section */}
        <div className="config-section">
          <button
            className={`config-section-header ${panels.type ? 'expanded' : ''}`}
            onClick={() => togglePanel('type')}
          >
            <span className="config-section-icon">▶</span>
            <span className="config-section-label">Property type</span>
            <span className="config-section-value">
              {typeInfo && <span className="config-value-icon">{typeInfo.icon}</span>}
              {typeInfo?.label || property.type}
            </span>
          </button>
          
          {panels.type && (
            <div className="config-section-content">
              <div className="config-type-list">
                {PROPERTY_TYPES.map(pt => (
                  <button
                    key={pt.type}
                    className={`config-type-option ${property.type === pt.type ? 'selected' : ''}`}
                    disabled // Type cannot be changed after creation
                    title="Property type cannot be changed after creation"
                  >
                    <span className="config-type-icon">{pt.icon}</span>
                    <span className="config-type-label">{pt.label}</span>
                    {property.type === pt.type && (
                      <span className="config-type-check">*</span>
                    )}
                  </button>
                ))}
              </div>
              <p className="config-hint">Property type cannot be changed after creation.</p>
            </div>
          )}
        </div>
        
        {/* Default value section */}
        <div className="config-section">
          <button
            className={`config-section-header ${panels.defaultValue ? 'expanded' : ''}`}
            onClick={() => togglePanel('defaultValue')}
          >
            <span className="config-section-icon">▶</span>
            <span className="config-section-label">Default value</span>
            <span className="config-section-value config-value-empty">None</span>
          </button>
          
          {panels.defaultValue && (
            <div className="config-section-content">
              <p className="config-hint">
                Default values can be set when the property is linked to a type.
              </p>
            </div>
          )}
        </div>
        
        {/* Available choices section (for selection type) */}
        {property.type === 'selection' && (
          <div className="config-section">
            <button
              className={`config-section-header ${panels.choices ? 'expanded' : ''}`}
              onClick={() => togglePanel('choices')}
            >
              <span className="config-section-icon">▶</span>
              <span className="config-section-label">Available choices</span>
              <span className="config-section-value">
                {property.options.length} choice{property.options.length !== 1 ? 's' : ''}
              </span>
            </button>
            
            {panels.choices && (
              <div className="config-section-content">
                {/* Existing choices */}
                <div className="config-choices-list">
                  {property.options.map(option => (
                    <div key={option.id} className="config-choice-item">
                      <span className="config-choice-icon">
                        {option.icon || '○'}
                      </span>
                      <span className="config-choice-name">{option.name}</span>
                      <button
                        className="config-choice-delete"
                        onClick={() => handleDeleteChoice(option)}
                        title="Delete choice"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  
                  {property.options.length === 0 && (
                    <p className="config-empty">No choices defined yet.</p>
                  )}
                </div>
                
                {/* Add choice sub-section */}
                <div className="config-subsection">
                  <button
                    className={`config-subsection-header ${panels.addChoice ? 'expanded' : ''}`}
                    onClick={() => togglePanel('addChoice')}
                  >
                    <span className="config-section-icon">▶</span>
                    <span className="config-subsection-label">Add choice</span>
                  </button>
                  
                  {panels.addChoice && (
                    <div className="config-subsection-content">
                      <div className="config-field">
                        <label className="config-label">Name</label>
                        <input
                          type="text"
                          className="config-input"
                          value={newChoiceName}
                          onChange={(e) => setNewChoiceName(e.target.value)}
                          placeholder="Choice name"
                        />
                      </div>
                      
                      <div className="config-field">
                        <label className="config-label">Icon (optional)</label>
                        <EmojiPickerTrigger
                          value={newChoiceIcon}
                          onSelect={setNewChoiceIcon}
                          placeholder="Add icon"
                          className="config-icon-trigger"
                        />
                      </div>
                      
                      <div className="config-actions">
                        <Button variant="default" size="sm" className="config-btn" onClick={() => togglePanel('addChoice')}>
                          Cancel
                        </Button>
                        <Button variant="primary" size="sm" className="config-btn" onClick={handleAddChoice}>
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
        <div className="config-section">
          <div className="config-section-header config-section-readonly">
            <span className="config-section-icon"></span>
            <span className="config-section-label">Scope</span>
            <span className="config-section-value">
              <span className="config-scope-badge" data-scope={property.is_local ? 'local' : 'global'}>
                {property.is_local ? '📍 Local' : '🌐 Global'}
              </span>
            </span>
          </div>
          <div className="config-scope-description">
            {property.is_local 
              ? 'This property is local - only available for specific nodes and their typed nodes.'
              : 'This property is global - available for any node with a unique name.'
            }
          </div>
        </div>
        
        {/* Hide options section */}
        <div className="config-section">
          <button
            className={`config-section-header ${panels.hideOptions ? 'expanded' : ''}`}
            onClick={() => togglePanel('hideOptions')}
          >
            <span className="config-section-icon">▶</span>
            <span className="config-section-label">Hide by default</span>
            <span className="config-section-value">Off</span>
          </button>
          
          {panels.hideOptions && (
            <div className="config-section-content">
              <div className="config-toggle-row">
                <span className="config-toggle-label">Hide by default</span>
                <label className="config-toggle">
                  <input type="checkbox" />
                  <span className="config-toggle-slider"></span>
                </label>
              </div>
              
              <div className="config-toggle-row">
                <span className="config-toggle-label">Hide empty value</span>
                <label className="config-toggle">
                  <input type="checkbox" />
                  <span className="config-toggle-slider"></span>
                </label>
              </div>
              
              <p className="config-hint">
                These settings will be available in a future update.
              </p>
            </div>
          )}
        </div>
        
        {/* Divider */}
        <div className="config-divider"></div>
        
        {/* Actions section */}
        <div className="config-actions-section">
          {onOpenPropertyView && (
            <Button variant="ghost" className="config-action-btn" onClick={handleGoToProperty}>
              <span className="config-action-icon"></span>
              <span>Go to this property</span>
            </Button>
          )}
          
          {!property.is_system && onDelete && (
            <Button variant="ghost" className="config-action-btn delete" onClick={handleDeleteClick}>
              <span className="config-action-icon"></span>
              <span>Delete property from database</span>
            </Button>
          )}
          
          {property.is_system && (
            <p className="config-hint config-system-hint">
              This is a system property and cannot be deleted.
            </p>
          )}
        </div>
      </div>
      
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
    </div>
  );
}

export default PropertyConfigPanel;
