/**
 * PropertyForm - Reusable property configuration form
 * 
 * Shared form layout and fields used by both PropertyCreateModal and PropertyConfigSection.
 * Provides a consistent interface for editing property settings.
 */
import { useCallback } from 'react';
import { mdiEarth, mdiLock, mdiNumeric1, mdiNumeric9Plus, mdiPlus, mdiTrashCan } from '@mdi/js';
import type { PropertyType, Node } from '@/types/api';
import { EmojiPickerTrigger } from '../core/EmojiPicker';
import { TextField } from '../core/TextField';
import { SelectionButton } from '../core/SelectionButton';
import { Button } from '../core/Button';
import { ListSortable } from '../core/ListSortable';
import { SuggestionPopup } from '../SuggestionPopup';
import './PropertyForm.css';

export interface PropertyTypeOption {
  type: PropertyType;
  label: string;
  description: string;
  supportsMultiValue: boolean;
}

export const PROPERTY_TYPE_OPTIONS: PropertyTypeOption[] = [
  { type: 'text', label: 'Text', description: 'Single or multi-line text', supportsMultiValue: false },
  { type: 'integer', label: 'Number', description: 'Whole numbers', supportsMultiValue: false },
  { type: 'float', label: 'Decimal', description: 'Numbers with decimals', supportsMultiValue: false },
  { type: 'boolean', label: 'Checkbox', description: 'True/false value', supportsMultiValue: false },
  { type: 'date', label: 'Date', description: 'Date picker', supportsMultiValue: false },
  { type: 'selection', label: 'Selection', description: 'Choose from options', supportsMultiValue: true },
  { type: 'node', label: 'Node', description: 'Link to another node', supportsMultiValue: true },
];

interface SelectionOptionWithId {
  id: string;
  name: string;
  icon?: string;
}

export interface PropertyFormProps {
  // Basic fields
  icon: string;
  name: string;
  propertyType: PropertyType;
  isLocal: boolean;
  isMultiValue: boolean;
  defaultValue: string;
  nameError?: string | null;
  
  // Selection options (for selection type)
  selectionOptions: SelectionOptionWithId[];
  newOptionName: string;
  newOptionIcon: string;
  showAddOption: boolean;
  
  // Allowed classes (for node type)
  allowedClasses: Node[];
  showClassSelector: boolean;
  typeClasses: Node[];
  
  // Handlers
  onIconChange: (icon: string) => void;
  onNameChange: (name: string) => void;
  onTypeChange?: (type: PropertyType) => void;
  onIsLocalChange: (isLocal: boolean) => void;
  onIsMultiValueChange: (isMultiValue: boolean) => void;
  onDefaultValueChange: (value: string) => void;
  
  onAddOption: () => void;
  onRemoveOption: (id: string) => void;
  onReorderOptions: (fromIndex: number, toIndex: number) => void;
  onNewOptionNameChange: (name: string) => void;
  onNewOptionIconChange: (icon: string) => void;
  onShowAddOptionChange: (show: boolean) => void;
  
  onAddClass: (node: Node) => void;
  onRemoveClass: (id: number) => void;
  onShowClassSelectorChange: (show: boolean) => void;
  
  // Config
  readOnly?: boolean;
  showTypeSelection?: boolean;
  showScopeSelection?: boolean;
  showMultiValueSelection?: boolean;
  showDefaultValue?: boolean;
  showSelectionOptions?: boolean;
  showAllowedClasses?: boolean;
  autoFocusName?: boolean;
}

export function PropertyForm({
  icon,
  name,
  propertyType,
  isLocal,
  isMultiValue,
  defaultValue,
  nameError,
  
  selectionOptions,
  newOptionName,
  newOptionIcon,
  showAddOption,
  
  allowedClasses,
  showClassSelector,
  typeClasses,
  
  onIconChange,
  onNameChange,
  onTypeChange,
  onIsLocalChange,
  onIsMultiValueChange,
  onDefaultValueChange,
  
  onAddOption,
  onRemoveOption,
  onReorderOptions,
  onNewOptionNameChange,
  onNewOptionIconChange,
  onShowAddOptionChange,
  
  onAddClass,
  onRemoveClass,
  onShowClassSelectorChange,
  
  readOnly = false,
  showTypeSelection = true,
  showScopeSelection = true,
  showMultiValueSelection = true,
  showDefaultValue = true,
  showSelectionOptions = true,
  showAllowedClasses = true,
  autoFocusName = false,
}: PropertyFormProps) {
  const typeOption = PROPERTY_TYPE_OPTIONS.find(t => t.type === propertyType);
  
  const handleAddOptionKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onAddOption();
    } else if (e.key === 'Escape') {
      onShowAddOptionChange(false);
      onNewOptionNameChange('');
      onNewOptionIconChange('');
    }
  }, [onAddOption, onShowAddOptionChange, onNewOptionNameChange, onNewOptionIconChange]);
  
  return (
    <div className="property-form">
      {/* Icon and Name */}
      <div className="property-form__field">
        <label className="property-form__label">Name</label>
        <div className="property-form__name-row">
          <EmojiPickerTrigger
            value={icon}
            onSelect={onIconChange}
            className="property-form__icon-picker"
          />
          <TextField
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Property name"
            error={!!nameError}
            errorMessage={nameError || undefined}
            disabled={readOnly}
            autoFocus={autoFocusName}
          />
        </div>
      </div>
      
      {/* Type Selection */}
      {showTypeSelection && onTypeChange && (
        <div className="property-form__field">
          <label className="property-form__label">Type</label>
          <div className="property-form__type-grid">
            {PROPERTY_TYPE_OPTIONS.map((type) => (
              <button
                key={type.type}
                className={`property-form__type-option ${
                  propertyType === type.type ? 'property-form__type-option--selected' : ''
                }`}
                onClick={() => !readOnly && onTypeChange(type.type)}
                disabled={readOnly}
              >
                <div className="property-form__type-label">{type.label}</div>
                <div className="property-form__type-description">{type.description}</div>
              </button>
            ))}
          </div>
        </div>
      )}
      
      {/* Type Display (read-only) */}
      {!showTypeSelection && (
        <div className="property-form__field">
          <label className="property-form__label">Type</label>
          <div className="property-form__type-display">
            {typeOption?.label || propertyType}
          </div>
          <div className="property-form__help-text">
            Property type cannot be changed after creation.
          </div>
        </div>
      )}
      
      {/* Scope */}
      {showScopeSelection && (
        <div className="property-form__field">
          <label className="property-form__label">Scope</label>
          <SelectionButton
            options={[
              { value: 'global', icon: mdiEarth, label: 'Global' },
              { value: 'local', icon: mdiLock, label: 'Local' },
            ]}
            value={isLocal ? 'local' : 'global'}
            onChange={(value) => !readOnly && onIsLocalChange(value === 'local')}
            size="md"
            disabled={readOnly}
          />
          <div className="property-form__help-text">
            {isLocal 
              ? 'Local properties are only available for specific nodes and their typed nodes'
              : 'Global properties are available for all nodes'
            }
          </div>
        </div>
      )}
      
      {/* Multi-value (for applicable types) */}
      {showMultiValueSelection && typeOption?.supportsMultiValue && (
        <div className="property-form__field">
          <label className="property-form__label">Values</label>
          <SelectionButton
            options={[
              { value: 'single', icon: mdiNumeric1, label: 'Single value' },
              { value: 'multi', icon: mdiNumeric9Plus, label: 'Multiple values' },
            ]}
            value={isMultiValue ? 'multi' : 'single'}
            onChange={(value) => !readOnly && onIsMultiValueChange(value === 'multi')}
            size="md"
            disabled={readOnly}
          />
        </div>
      )}
      
      {/* Selection Options (for selection type) */}
      {showSelectionOptions && propertyType === 'selection' && (
        <div className="property-form__field">
          <label className="property-form__label">Options</label>
          {selectionOptions.length > 0 && (
            <ListSortable
              items={selectionOptions}
              onReorder={onReorderOptions}
              renderIcon={(opt) => opt.icon || ''}
              renderText={(opt) => opt.name}
              renderActions={(opt) => [
                <Button
                  key="delete"
                  variant="ghost"
                  size="sm"
                  icon={mdiTrashCan}
                  onClick={() => onRemoveOption(opt.id)}
                  aria-label="Remove option"
                  disabled={readOnly}
                />,
              ]}
              className="property-form__options-list"
            />
          )}
          
          {!readOnly && (
            <>
              {showAddOption ? (
                <div className="property-form__add-option">
                  <EmojiPickerTrigger
                    value={newOptionIcon}
                    onSelect={onNewOptionIconChange}
                    className="property-form__option-icon-picker"
                  />
                  <TextField
                    value={newOptionName}
                    onChange={(e) => onNewOptionNameChange(e.target.value)}
                    placeholder="Option name"
                    onKeyDown={handleAddOptionKeyDown}
                    autoFocus
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={onAddOption}
                    disabled={!newOptionName.trim()}
                  >
                    Add
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      onShowAddOptionChange(false);
                      onNewOptionNameChange('');
                      onNewOptionIconChange('');
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
                  onClick={() => onShowAddOptionChange(true)}
                >
                  Add Option
                </Button>
              )}
            </>
          )}
        </div>
      )}
      
      {/* Allowed Classes (for node type) */}
      {showAllowedClasses && propertyType === 'node' && (
        <div className="property-form__field">
          <label className="property-form__label">Allowed Classes</label>
          {allowedClasses.length > 0 && (
            <div className="property-form__allowed-classes">
              {allowedClasses.map((cls) => (
                <div key={cls.id} className="property-form__class-pill">
                  {cls.icon && <span>{cls.icon}</span>}
                  <span>{cls.name}</span>
                  {!readOnly && (
                    <button
                      onClick={() => onRemoveClass(cls.id)}
                      className="property-form__class-remove"
                      aria-label="Remove class"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {!readOnly && (
            <Button
              variant="default"
              size="sm"
              icon={mdiPlus}
              onClick={() => onShowClassSelectorChange(true)}
            >
              {allowedClasses.length > 0 ? 'Add Another Class' : 'Add Class'}
            </Button>
          )}
          
          {showClassSelector && (
            <SuggestionPopup
              isOpen={showClassSelector}
              query=""
              type="class"
              position={{ top: 0, left: 0 }}
              onSelect={onAddClass}
              onClose={() => onShowClassSelectorChange(false)}
              multiSelect={false}
              allNodes={typeClasses.filter(cls => !allowedClasses.some(ac => ac.id === cls.id))}
            />
          )}
        </div>
      )}
      
      {/* Default Value */}
      {showDefaultValue && propertyType !== 'selection' && propertyType !== 'node' && (
        <div className="property-form__field">
          <label className="property-form__label">Default Value (Optional)</label>
          {propertyType === 'boolean' ? (
            <SelectionButton
              options={[
                { value: '', icon: mdiNumeric1, label: 'None' },
                { value: 'true', icon: mdiNumeric1, label: 'Checked' },
                { value: 'false', icon: mdiNumeric1, label: 'Unchecked' },
              ]}
              value={defaultValue}
              onChange={onDefaultValueChange}
              size="md"
              disabled={readOnly}
            />
          ) : (
            <TextField
              value={defaultValue}
              onChange={(e) => onDefaultValueChange(e.target.value)}
              placeholder={`Default ${typeOption?.label.toLowerCase() || 'value'}`}
              type={propertyType === 'integer' || propertyType === 'float' ? 'number' : 'text'}
              disabled={readOnly}
            />
          )}
        </div>
      )}
      
      {/* Selection Default Value */}
      {showDefaultValue && propertyType === 'selection' && selectionOptions.length > 0 && (
        <div className="property-form__field">
          <label className="property-form__label">Default Value (Optional)</label>
          <select
            value={defaultValue}
            onChange={(e) => onDefaultValueChange(e.target.value)}
            className="property-form__select"
            disabled={readOnly}
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
  );
}
