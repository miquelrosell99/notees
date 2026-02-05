/**
 * PropertyCreateModal - Comprehensive property creation dialog
 * 
 * Full-featured modal for creating new properties with:
 * - Icon selection (emoji picker)
 * - Name with availability check
 * - Type selection (text, number, boolean, date, selection, node)
 * - Scope (global/local)
 * - Single/multi value support (where applicable)
 * - Default value configuration
 * - Selection options editor (for selection type)
 * - Allowed classes selector (for node type)
 */
import { useState, useCallback, useMemo, useEffect } from 'react';
import { mdiEarth, mdiLock, mdiNumeric1, mdiNumeric9Plus, mdiPlus, mdiTrashCan } from '@mdi/js';
import type { PropertyType, PropertyCreate, Node } from '@/types/api';
import { useProperties, useNodes } from '@/hooks';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { SelectionButton } from '../core/SelectionButton';
import { EmojiPickerTrigger } from '../core/EmojiPicker';
import { ListSortable } from '../core/ListSortable';
import { TextField } from '../core/TextField';
import { SuggestionPopup } from '../SuggestionPopup';
import './PropertyCreateModal.css';

export interface PropertyTypeOption {
  type: PropertyType;
  label: string;
  description: string;
  supportsMultiValue: boolean;
}

export const PROPERTY_TYPES: PropertyTypeOption[] = [
  { type: 'text', label: 'Text', description: 'Single or multi-line text', supportsMultiValue: false },
  { type: 'integer', label: 'Number', description: 'Whole numbers', supportsMultiValue: false },
  { type: 'float', label: 'Decimal', description: 'Numbers with decimals', supportsMultiValue: false },
  { type: 'boolean', label: 'Checkbox', description: 'True/false value', supportsMultiValue: false },
  { type: 'date', label: 'Date', description: 'Date picker', supportsMultiValue: false },
  { type: 'selection', label: 'Selection', description: 'Choose from options', supportsMultiValue: true },
  { type: 'node', label: 'Node', description: 'Link to another node', supportsMultiValue: true },
];

interface SelectionOption {
  id: string;
  name: string;
  icon?: string;
}

export interface PropertyCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (data: PropertyCreate & { selection_options?: { name: string; icon?: string }[] }) => void;
  /** Optional initial name to pre-populate the field */
  initialName?: string;
}

export function PropertyCreateModal({
  isOpen,
  onClose,
  onCreate,
  initialName = '',
}: PropertyCreateModalProps) {
  // Basic fields
  const [icon, setIcon] = useState('');
  const [name, setName] = useState('');
  const [selectedType, setSelectedType] = useState<PropertyType>('text');
  const [isLocal, setIsLocal] = useState(false);
  const [isMultiValue, setIsMultiValue] = useState(false);
  const [defaultValue, setDefaultValue] = useState('');
  
  // Selection options (for selection type)
  const [selectionOptions, setSelectionOptions] = useState<SelectionOption[]>([]);
  const [newOptionName, setNewOptionName] = useState('');
  const [newOptionIcon, setNewOptionIcon] = useState('');
  const [showAddOption, setShowAddOption] = useState(false);
  
  // Allowed classes (for node type)
  const [allowedClasses, setAllowedClasses] = useState<Node[]>([]);
  const [showClassSelector, setShowClassSelector] = useState(false);
  
  // Data fetching
  const { data: existingProperties } = useProperties();
  const { data: allNodes } = useNodes();
  
  // Check name availability
  const nameError = useMemo(() => {
    if (!name.trim()) return null;
    if (existingProperties?.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return 'A property with this name already exists';
    }
    return null;
  }, [name, existingProperties]);
  
  // Get type option
  const typeOption = useMemo(() => 
    PROPERTY_TYPES.find(t => t.type === selectedType),
    [selectedType]
  );
  
  // Validation
  const canCreate = useMemo(() => {
    if (!name.trim() || nameError) return false;
    
    // For selection type, need at least one option before allowing default value
    if (selectedType === 'selection' && selectionOptions.length === 0 && defaultValue) {
      return false;
    }
    
    return true;
  }, [name, nameError, selectedType, selectionOptions, defaultValue]);
  
  // Reset form when modal closes
  useEffect(() => {
    if (!isOpen) {
      setIcon('');
      setName('');
      setSelectedType('text');
      setIsLocal(false);
      setIsMultiValue(false);
      setDefaultValue('');
      setSelectionOptions([]);
      setNewOptionName('');
      setNewOptionIcon('');
      setShowAddOption(false);
      setAllowedClasses([]);
      setShowClassSelector(false);
    } else if (initialName) {
      // Set initial name when opening
      setName(initialName);
    }
  }, [isOpen, initialName]);
  
  // Handle type change
  const handleTypeChange = useCallback((type: string) => {
    setSelectedType(type as PropertyType);
    setIsMultiValue(false); // Reset multi-value when type changes
    setDefaultValue(''); // Reset default value
    
    // Clear type-specific data
    if (type !== 'selection') {
      setSelectionOptions([]);
    }
    if (type !== 'node') {
      setAllowedClasses([]);
    }
  }, []);
  
  // Selection options handlers
  const handleAddOption = useCallback(() => {
    if (!newOptionName.trim()) return;
    
    setSelectionOptions(prev => [
      ...prev,
      {
        id: `temp-${Date.now()}`,
        name: newOptionName.trim(),
        icon: newOptionIcon || undefined,
      },
    ]);
    setNewOptionName('');
    setNewOptionIcon('');
    setShowAddOption(false);
  }, [newOptionName, newOptionIcon]);
  
  const handleRemoveOption = useCallback((id: string) => {
    setSelectionOptions(prev => prev.filter(opt => opt.id !== id));
  }, []);
  
  const handleReorderOptions = useCallback((fromIndex: number, toIndex: number) => {
    setSelectionOptions(prev => {
      const items = [...prev];
      const [moved] = items.splice(fromIndex, 1);
      items.splice(toIndex, 0, moved);
      return items;
    });
  }, []);
  
  // Class selection handlers
  const handleSelectClass = useCallback((node: Node) => {
    if (!allowedClasses.some(c => c.id === node.id)) {
      setAllowedClasses(prev => [...prev, node]);
    }
  }, [allowedClasses]);
  
  const handleRemoveClass = useCallback((id: number) => {
    setAllowedClasses(prev => prev.filter(c => c.id !== id));
  }, []);
  
  // Create property
  const handleCreate = useCallback(() => {
    if (!canCreate) return;
    
    const data: PropertyCreate & { selection_options?: { name: string; icon?: string }[] } = {
      name: name.trim(),
      type: selectedType,
      is_local: isLocal,
      icon: icon || undefined,
    };
    
    // Add selection options if applicable
    if (selectedType === 'selection' && selectionOptions.length > 0) {
      data.selection_options = selectionOptions.map(opt => ({
        name: opt.name,
        icon: opt.icon,
      }));
    }
    
    // Note: Default value and allowed classes handled separately via API after creation
    // For now we'll pass them through if needed
    
    onCreate(data);
    onClose();
  }, [canCreate, name, selectedType, isLocal, icon, selectionOptions, onCreate, onClose]);
  
  // Get type classes for display
  const typeClasses = useMemo(() => 
    allNodes?.filter(n => n.is_class) || [],
    [allNodes]
  );
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create Property"
      size="md"
      showCloseButton
      footer={
        <div className="property-create-modal__footer">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button 
            variant="primary" 
            onClick={handleCreate}
            disabled={!canCreate}
          >
            Create Property
          </Button>
        </div>
      }
    >
      <div className="property-create-modal__content">
        {/* Icon and Name */}
        <div className="property-create-modal__field">
          <label className="property-create-modal__label">Name</label>
          <div className="property-create-modal__name-row">
            <EmojiPickerTrigger
              value={icon}
              onSelect={setIcon}
              className="property-create-modal__icon-picker"
            />
            <TextField
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Property name"
              error={!!nameError}
              errorMessage={nameError || undefined}
              autoFocus
            />
          </div>
        </div>
        
        {/* Type Selection */}
        <div className="property-create-modal__field">
          <label className="property-create-modal__label">Type</label>
          <div className="property-create-modal__type-grid">
            {PROPERTY_TYPES.map((type) => (
              <button
                key={type.type}
                className={`property-create-modal__type-option ${
                  selectedType === type.type ? 'property-create-modal__type-option--selected' : ''
                }`}
                onClick={() => handleTypeChange(type.type)}
              >
                <div className="property-create-modal__type-label">{type.label}</div>
                <div className="property-create-modal__type-description">{type.description}</div>
              </button>
            ))}
          </div>
        </div>
        
        {/* Scope */}
        <div className="property-create-modal__field">
          <label className="property-create-modal__label">Scope</label>
          <SelectionButton
            options={[
              { value: 'global', icon: mdiEarth, label: 'Global' },
              { value: 'local', icon: mdiLock, label: 'Local' },
            ]}
            value={isLocal ? 'local' : 'global'}
            onChange={(value) => setIsLocal(value === 'local')}
            size="md"
          />
          <div className="property-create-modal__help-text">
            {isLocal 
              ? 'Local properties are only available for specific nodes and their typed nodes'
              : 'Global properties are available for all nodes'
            }
          </div>
        </div>
        
        {/* Multi-value (for applicable types) */}
        {typeOption?.supportsMultiValue && (
          <div className="property-create-modal__field">
            <label className="property-create-modal__label">Values</label>
            <SelectionButton
              options={[
                { value: 'single', icon: mdiNumeric1, label: 'Single value' },
                { value: 'multi', icon: mdiNumeric9Plus, label: 'Multiple values' },
              ]}
              value={isMultiValue ? 'multi' : 'single'}
              onChange={(value) => setIsMultiValue(value === 'multi')}
              size="md"
            />
          </div>
        )}
        
        {/* Selection Options (for selection type) */}
        {selectedType === 'selection' && (
          <div className="property-create-modal__field">
            <label className="property-create-modal__label">Options</label>
            {selectionOptions.length > 0 && (
              <ListSortable
                items={selectionOptions}
                onReorder={handleReorderOptions}
                renderIcon={(opt) => opt.icon || ''}
                renderText={(opt) => opt.name}
                renderActions={(opt) => [
                  <Button
                    key="delete"
                    variant="ghost"
                    size="sm"
                    icon={mdiTrashCan}
                    onClick={() => handleRemoveOption(opt.id)}
                    aria-label="Remove option"
                  />,
                ]}
                className="property-create-modal__options-list"
              />
            )}
            
            {showAddOption ? (
              <div className="property-create-modal__add-option">
                <EmojiPickerTrigger
                  value={newOptionIcon}
                  onSelect={setNewOptionIcon}
                  className="property-create-modal__option-icon-picker"
                />
                <TextField
                  value={newOptionName}
                  onChange={(e) => setNewOptionName(e.target.value)}
                  placeholder="Option name"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddOption();
                    } else if (e.key === 'Escape') {
                      setShowAddOption(false);
                      setNewOptionName('');
                      setNewOptionIcon('');
                    }
                  }}
                  autoFocus
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleAddOption}
                  disabled={!newOptionName.trim()}
                >
                  Add
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowAddOption(false);
                    setNewOptionName('');
                    setNewOptionIcon('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="default"
                size="sm"
                icon={mdiPlus}
                onClick={() => setShowAddOption(true)}
              >
                Add Option
              </Button>
            )}
          </div>
        )}
        
        {/* Allowed Classes (for node type) */}
        {selectedType === 'node' && (
          <div className="property-create-modal__field">
            <label className="property-create-modal__label">Allowed Classes</label>
            {allowedClasses.length > 0 && (
              <div className="property-create-modal__allowed-classes">
                {allowedClasses.map((cls) => (
                  <div key={cls.id} className="property-create-modal__class-pill">
                    {cls.icon && <span>{cls.icon}</span>}
                    <span>{cls.name}</span>
                    <button
                      onClick={() => handleRemoveClass(cls.id)}
                      className="property-create-modal__class-remove"
                      aria-label="Remove class"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <Button
              variant="default"
              size="sm"
              icon={mdiPlus}
              onClick={() => setShowClassSelector(true)}
            >
              {allowedClasses.length > 0 ? 'Add Another Class' : 'Add Class'}
            </Button>
            
            {showClassSelector && (
              <SuggestionPopup
                isOpen={showClassSelector}
                query=""
                type="class"
                position={{ top: 0, left: 0 }}
                onSelect={handleSelectClass}
                onClose={() => setShowClassSelector(false)}
                multiSelect={false}
                allNodes={typeClasses.filter(cls => !allowedClasses.some(ac => ac.id === cls.id))}
              />
            )}
          </div>
        )}
        
        {/* Default Value */}
        {selectedType !== 'selection' && selectedType !== 'node' && (
          <div className="property-create-modal__field">
            <label className="property-create-modal__label">Default Value (Optional)</label>
            {selectedType === 'boolean' ? (
              <SelectionButton
                options={[
                  { value: '', icon: mdiNumeric1, label: 'None' },
                  { value: 'true', icon: mdiNumeric1, label: 'Checked' },
                  { value: 'false', icon: mdiNumeric1, label: 'Unchecked' },
                ]}
                value={defaultValue}
                onChange={setDefaultValue}
                size="md"
              />
            ) : (
              <TextField
                value={defaultValue}
                onChange={(e) => setDefaultValue(e.target.value)}
                placeholder={`Default ${typeOption?.label.toLowerCase() || 'value'}`}
                type={selectedType === 'integer' || selectedType === 'float' ? 'number' : 'text'}
              />
            )}
          </div>
        )}
        
        {/* Selection Default Value */}
        {selectedType === 'selection' && selectionOptions.length > 0 && (
          <div className="property-create-modal__field">
            <label className="property-create-modal__label">Default Value (Optional)</label>
            <select
              value={defaultValue}
              onChange={(e) => setDefaultValue(e.target.value)}
              className="property-create-modal__select"
            >
              <option value="">None</option>
              {selectionOptions.map((opt) => (
                <option key={opt.id} value={opt.name}>
                  {opt.icon} {opt.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </Modal>
  );
}
