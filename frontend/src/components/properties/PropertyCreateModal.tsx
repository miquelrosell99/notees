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
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { PropertyType, PropertyCreate, PropertyScope, Node } from '@/types/api';
import { useProperties, useNodes } from '@/hooks';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { PropertyForm } from './PropertyForm';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import './PropertyCreateModal.css';

export interface PropertyTypeOption {
  type: PropertyType;
  label: string;
  description: string;
  supportsMultiValue: boolean;
}

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
  /** If provided, locks the scope of the created property (hides scope toggle) */
  initialScope?: PropertyScope;
}

export function PropertyCreateModal({
  isOpen,
  onClose,
  onCreate,
  initialName = '',
  initialScope,
}: PropertyCreateModalProps) {
  // Basic fields
  const [icon, setIcon] = useState('');
  const [name, setName] = useState('');
  const [selectedType, setSelectedType] = useState<PropertyType>('text');
  const [scope, setScope] = useState<PropertyScope>(initialScope ?? 'global');
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
      setScope(initialScope ?? 'global');
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
  }, [isOpen, initialName, initialScope]);
  
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
      scope,
      is_local: scope !== 'global',  // backward compat
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
  }, [canCreate, name, selectedType, scope, icon, selectionOptions, onCreate, onClose]);
  
  // Get type classes for display (exclude page class)
  const typeClasses = useMemo(() => 
    allNodes?.filter(n => n.is_class && n.uuid !== SYSTEM_CLASS_UUIDS.page) || [],
    [allNodes]
  );

  // Enter anywhere inside the modal = create (capture phase)
  // Use ref so the listener always sees the latest handleCreate without re-registering
  const handleCreateRef = useRef(handleCreate);
  handleCreateRef.current = handleCreate;
  const canCreateRef = useRef(canCreate);
  canCreateRef.current = canCreate;
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement;
      if (!target.closest('.property-create-modal')) return;
      // Don't intercept Enter inside NodeSelector dropdowns (portaled outside modal)
      if (target.closest('.node-selector__dropdown')) return;
      e.preventDefault();
      e.stopPropagation();
      if (canCreateRef.current) handleCreateRef.current();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [isOpen]);
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create Property"
      size="md"
      className="property-create-modal"
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
      <PropertyForm
        icon={icon}
        name={name}
        propertyType={selectedType}
        isLocal={scope !== 'global'}
        isMultiValue={isMultiValue}
        defaultValue={defaultValue}
        nameError={nameError}
        selectionOptions={selectionOptions}
        newOptionName={newOptionName}
        newOptionIcon={newOptionIcon}
        showAddOption={showAddOption}
        allowedClasses={allowedClasses}
        showClassSelector={showClassSelector}
        typeClasses={typeClasses}
        onIconChange={setIcon}
        onNameChange={setName}
        onTypeChange={handleTypeChange}
        onIsLocalChange={(val) => setScope(val ? (initialScope && initialScope !== 'global' ? initialScope : 'node') : 'global')}
        isLocalLocked={!!initialScope}  // Lock scope toggle when scope is pre-decided
        onIsMultiValueChange={setIsMultiValue}
        onDefaultValueChange={setDefaultValue}
        onAddOption={handleAddOption}
        onRemoveOption={handleRemoveOption}
        onReorderOptions={handleReorderOptions}
        onNewOptionNameChange={setNewOptionName}
        onNewOptionIconChange={setNewOptionIcon}
        onShowAddOptionChange={setShowAddOption}
        onAddClass={handleSelectClass}
        onRemoveClass={handleRemoveClass}
        onShowClassSelectorChange={setShowClassSelector}
        autoFocusName
      />
    </Modal>
  );
}
