/**
 * PropertyForm - Reusable property configuration form
 * 
 * Shared form layout and fields used by both PropertyCreateModal and PropertyConfigSection.
 * Provides a consistent interface for editing property settings.
 */
import { useCallback, useId, useRef, useEffect } from 'react';
import type { PropertyType, Node } from '@/types/api';
import { parseIconField, formatIconField } from '@/utils/iconDom';
import { EmojiPickerTrigger } from '@/components/ui/EmojiPicker';
import { TextField } from '@/components/ui/TextField';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { Button } from '@/components/ui/Button';
import { ListSortable } from '@/components/ui/ListSortable';
import { NodeSelector } from '@/features/content';
import './PropertyForm.css';

interface PropertyTypeOption {
  type: PropertyType;
  label: string;
  description: string;
  supportsMultiValue: boolean;
}

const PROPERTY_TYPE_OPTIONS: PropertyTypeOption[] = [
  { type: 'text', label: 'Text', description: 'Single or multi-line text', supportsMultiValue: true },
  { type: 'integer', label: 'Number', description: 'Whole numbers', supportsMultiValue: false },
  { type: 'float', label: 'Decimal', description: 'Numbers with decimals', supportsMultiValue: false },
  { type: 'boolean', label: 'Checkbox', description: 'True/false value', supportsMultiValue: false },
  { type: 'date', label: 'Date', description: 'Date picker', supportsMultiValue: false },
  { type: 'selection', label: 'Selection', description: 'Choose from options', supportsMultiValue: true },
  { type: 'node', label: 'Node', description: 'Link to another node', supportsMultiValue: true },
  { type: 'url', label: 'URL', description: 'Web link', supportsMultiValue: false },
  { type: 'email', label: 'Email', description: 'Email address', supportsMultiValue: false },
  { type: 'image', label: 'Image', description: 'Image asset', supportsMultiValue: false },
];

interface SelectionOptionWithId {
  id: string;
  name: string;
  icon?: string; // raw stored value: plain icon name or JSON {"icon":"...","color":"..."}
}

export interface PropertyFormProps {
  // Basic fields
  icon: string;
  name: string;
  propertyType: PropertyType;
  isLocal: boolean;
  /** When true, the local/global toggle is hidden (scope is pre-decided externally) */
  isLocalLocked?: boolean;
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
  
  // Handlers
  onIconChange: (icon: string) => void;
  onNameChange: (name: string) => void;
  onTypeChange?: (type: PropertyType) => void;
  onIsLocalChange: (isLocal: boolean) => void;
  onIsMultiValueChange: (isMultiValue: boolean) => void;
  onDefaultValueChange: (value: string) => void;
  
  onAddOption: () => void;
  onRemoveOption: (id: string) => void;
  onOptionIconChange?: (id: string, icon: string) => void;
  onReorderOptions: (fromIndex: number, toIndex: number) => void;
  onNewOptionNameChange: (name: string) => void;
  onNewOptionIconChange: (icon: string) => void;
  onShowAddOptionChange: (show: boolean) => void;
  
  onAddClass: (node: Node) => void;
  onRemoveClass: (id: number) => void;
  
  // Config
  readOnly?: boolean;
  showTypeSelection?: boolean;
  showMultiValueSelection?: boolean;
  showDefaultValue?: boolean;
  showSelectionOptions?: boolean;
  showAllowedClasses?: boolean;
  autoFocusName?: boolean;
  showIconSelection?: boolean;
  showNameField?: boolean;
}

export function PropertyForm({
  icon,
  name,
  propertyType,
  isMultiValue,
  defaultValue,
  nameError,
  
  selectionOptions,
  newOptionName,
  newOptionIcon,
  showAddOption,
  
  allowedClasses,
  
  onIconChange,
  onNameChange,
  onTypeChange,
  onIsMultiValueChange,
  onDefaultValueChange,
  
  onAddOption,
  onRemoveOption,
  onOptionIconChange,
  onReorderOptions,
  onNewOptionNameChange,
  onNewOptionIconChange,
  onShowAddOptionChange,
  
  onAddClass,
  onRemoveClass,
  
  readOnly = false,
  showTypeSelection = true,
  showMultiValueSelection = true,
  showDefaultValue = true,
  showSelectionOptions = true,
  showAllowedClasses = true,
  autoFocusName = false,
  showIconSelection = true,
  showNameField = true,
}: PropertyFormProps) {
  const typeOption = PROPERTY_TYPE_OPTIONS.find(t => t.type === propertyType);

  const baseId = useId();
  const nameId = `${baseId}-name`;
  const typeId = `${baseId}-type`;
  const valuesId = `${baseId}-values`;
  const optionsId = `${baseId}-options`;
  const allowedClassesId = `${baseId}-allowed-classes`;
  const defaultValueId = `${baseId}-default-value`;
  const nameInputRef = useRef<HTMLInputElement>(null);
  const newOptionInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocusName && showNameField) {
      nameInputRef.current?.focus();
    }
  }, [autoFocusName, showNameField]);

  useEffect(() => {
    if (showAddOption && showSelectionOptions && propertyType === 'selection') {
      newOptionInputRef.current?.focus();
    }
  }, [showAddOption, showSelectionOptions, propertyType]);

  const nameLabelId = `${baseId}-name-label`;
  const typeLabelId = `${baseId}-type-label`;
  const valuesLabelId = `${baseId}-values-label`;
  const optionsLabelId = `${baseId}-options-label`;
  const allowedClassesLabelId = `${baseId}-allowed-classes-label`;
  const defaultValueLabelId = `${baseId}-default-value-label`;

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
      {(showIconSelection || showNameField) && (
        <div className="property-form__field">
          <label id={nameLabelId} htmlFor={nameId} className="property-form__label">Name</label>
          <div className="property-form__name-row">
            {showIconSelection && (
              <EmojiPickerTrigger
                value={icon}
                onSelect={onIconChange}
                className="property-form__icon-picker"
              />
            )}
            {showNameField && (
              <TextField
                id={nameId}
                ref={nameInputRef}
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                placeholder="Property name"
                error={!!nameError}
                errorMessage={nameError || undefined}
                disabled={readOnly}
              />
            )}
          </div>
        </div>
      )}
      
      {/* Type Selection */}
      {showTypeSelection && onTypeChange && (
        <div className="property-form__field">
          <label id={typeLabelId} htmlFor={typeId} className="property-form__label">Type</label>
          <div id={typeId} className="property-form__type-grid" role="radiogroup" aria-labelledby={typeLabelId}>
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
      
      {/* Multi-value (for applicable types) */}
      {showMultiValueSelection && typeOption?.supportsMultiValue && (
        <div className="property-form__field">
          <label id={valuesLabelId} htmlFor={valuesId} className="property-form__label">Values</label>
          <SelectionButton
            id={valuesId}
            aria-labelledby={valuesLabelId}
            options={[
              { value: 'single', icon: "mdi mdi-numeric-1", label: 'Single value' },
              { value: 'multi', icon: "mdi mdi-numeric-9-plus", label: 'Multiple values' },
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
          <label id={optionsLabelId} htmlFor={optionsId} className="property-form__label">Options</label>
          <div id={optionsId} role="group" aria-labelledby={optionsLabelId}>
            {selectionOptions.length > 0 && (
              <ListSortable
                items={selectionOptions}
                onReorder={onReorderOptions}
                renderIcon={(opt) => {
                  const { icon: parsedIcon, color: parsedColor } = parseIconField(opt.icon || '');
                  return (
                    <EmojiPickerTrigger
                      value={parsedIcon}
                      onSelect={(newIcon) =>
                        onOptionIconChange?.(opt.id, formatIconField(newIcon, parsedColor))
                      }
                      placeholder=""
                      className="property-form__option-icon-btn"
                      useColor={true}
                      color={parsedColor}
                      onColorChange={(newColor) =>
                        onOptionIconChange?.(opt.id, formatIconField(parsedIcon, newColor))
                      }
                    />
                  );
                }}
                renderText={(opt) => opt.name}
                renderActions={(opt) => [
                  <Button
                    key="delete"
                    variant="ghost"
                    size="sm"
                    icon={"mdi mdi-trash-can"}
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
                      ref={newOptionInputRef}
                      value={newOptionName}
                      onChange={(e) => onNewOptionNameChange(e.target.value)}
                      placeholder="Option name"
                      onKeyDown={handleAddOptionKeyDown}
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
                    icon={"mdi mdi-plus"}
                    onClick={() => onShowAddOptionChange(true)}
                  >
                    Add Option
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}
      
      {/* Allowed Classes (for node type) */}
      {showAllowedClasses && propertyType === 'node' && (
        <div className="property-form__field">
          <label id={allowedClassesLabelId} htmlFor={allowedClassesId} className="property-form__label">Allowed Classes</label>
          <div id={allowedClassesId} role="group" aria-labelledby={allowedClassesLabelId}>
            <NodeSelector
              nodes={allowedClasses}
              searchMode="classes"
              emptyText="Add class"
              searchPlaceholder="Search classes..."
              onNodeClick={() => {
                // Optional: navigate to class node
              }}
              onRemove={!readOnly ? (node) => onRemoveClass(node.id) : undefined}
              onAdd={!readOnly ? onAddClass : undefined}
              readOnly={readOnly}
            />
          </div>
        </div>
      )}
      
      {/* Default Value */}
      {showDefaultValue && propertyType !== 'node' && propertyType !== 'image' && (
        <div className="property-form__field">
          <label id={defaultValueLabelId} htmlFor={defaultValueId} className="property-form__label">Default Value (Optional)</label>
          {propertyType === 'boolean' ? (
            <select
              id={defaultValueId}
              value={defaultValue}
              onChange={(e) => onDefaultValueChange(e.target.value)}
              className="property-form__select"
              disabled={readOnly}
            >
              <option value="">None</option>
              <option value="true">Checked</option>
              <option value="false">Unchecked</option>
            </select>
          ) : propertyType === 'selection' && selectionOptions.length > 0 ? (
            <select
              id={defaultValueId}
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
          ) : (
            <TextField
              id={defaultValueId}
              value={defaultValue}
              onChange={(e) => onDefaultValueChange(e.target.value)}
              placeholder={
                propertyType === 'date' ? 'YYYY-MM-DD' :
                propertyType === 'url' ? 'https://example.com' :
                propertyType === 'email' ? 'name@example.com' :
                `Default ${typeOption?.label.toLowerCase() || 'value'}`
              }
              type={
                propertyType === 'integer' || propertyType === 'float' ? 'number' :
                propertyType === 'date' ? 'date' :
                propertyType === 'url' ? 'url' :
                propertyType === 'email' ? 'email' :
                'text'
              }
              disabled={readOnly}
            />
          )}
        </div>
      )}
      
    </div>
  );
}

