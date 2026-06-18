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
import { useState, useCallback, useMemo, useEffect, useId } from 'react';
import type { Property, Node, PropertyIconVisibility } from '@/types/api';
import { ICON_VISIBILITY_PROPERTY_TYPES } from '@/types/api';
import { addSelectionOption, deleteSelectionOption, updateSelectionOption, reorderSelectionOptions, addClassFilter, removeClassFilter } from '@/api/properties';
import { parseIconField } from '@/utils/iconDom';
import { useUpdateProperty } from '../hooks';
import { useClasses } from '@/features/content';
import { useNavigationStore } from '@/stores';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { TextField } from '@/components/ui/TextField';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { PropertyForm } from './PropertyForm';
import './PropertyConfigSection.css';

interface SelectionOptionWithId {
  id: string;
  name: string;
  icon?: string;
}

interface PropertyConfigSectionProps {
  property: Property;
  onUpdate: (property: Property) => void;
}

export function PropertyConfigSection({
  property,
  onUpdate,
}: PropertyConfigSectionProps) {
  // Form state (name and icon removed - they're in PageHeader now)
  const isLocal = property.scope !== 'global';
  const [isMultiValue, setIsMultiValue] = useState(property.multi || false);
  const [showMultiValueConfirm, setShowMultiValueConfirm] = useState(false);
  const defaultValue = ''; // default_value not yet supported by backend
  const openNode = useNavigationStore(state => state.openNode);
  const [newOptionName, setNewOptionName] = useState('');
  const [newOptionIcon, setNewOptionIcon] = useState('');
  const [showAddOption, setShowAddOption] = useState(false);
  const [allowedClasses, setAllowedClasses] = useState<Node[]>([]);
  const [error, setError] = useState<string | null>(null);
  
  // Mutations
  const updatePropertyMutation = useUpdateProperty();
  
  // Get all classes to resolve class_filters IDs to Node objects
  const { data: allClasses } = useClasses();
  
  // Sync isMultiValue with property.multi when property changes
  useEffect(() => {
    setIsMultiValue(property.multi || false);
  }, [property.multi]);
  
  // Load allowed classes from property.class_filters
  useEffect(() => {
    if (allClasses && property.class_filters) {
      const classNodes = property.class_filters
        .map(classId => allClasses.find(c => c.id === classId))
        .filter((c): c is Node => c !== undefined);
      setAllowedClasses(classNodes);
    }
  }, [allClasses, property.class_filters]);
  
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
      const { icon: parsedIcon, color: parsedColor } = parseIconField(newOptionIcon || '');
      const newOption = await addSelectionOption(
        property.id,
        newOptionName.trim(),
        parsedIcon || newOptionIcon || null,
        property.options.length, // sequence
        parsedColor || null,
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
  
  const handleUpdateSelectionOptionIcon = useCallback(async (id: string, iconField: string) => {
    // Parse color from the JSON icon field so we can save it to the dedicated color column
    const { icon: parsedIcon, color: parsedColor } = parseIconField(iconField);
    try {
      await updateSelectionOption(property.id, Number(id), { icon: parsedIcon || null, color: parsedColor || null });
      const updatedProperty: Property = {
        ...property,
        options: property.options.map(o =>
          String(o.id) === id ? { ...o, icon: iconField, color: parsedColor || null } : o
        ),
      };
      onUpdate(updatedProperty);
      setError(null);
    } catch (err) {
      setError('Failed to update option icon');
      console.error(err);
    }
  }, [property, onUpdate]);

  const handleReorderSelectionOptions = useCallback(async (reordered: SelectionOptionWithId[]) => {
    try {
      await reorderSelectionOptions(
        property.id,
        reordered.map(opt => ({ id: Number(opt.id) }))
      );
      const updatedProperty: Property = {
        ...property,
        options: reordered.map((opt, index) => ({
          id: Number(opt.id),
          name: opt.name,
          icon: opt.icon ?? null,
          color: null,
          sequence: index,
        })),
      };
      onUpdate(updatedProperty);
    } catch (err) {
      setError('Failed to reorder options');
      console.error(err);
    }
  }, [property, onUpdate]);
  
  // Allowed class handlers
  const handleAddAllowedClass = useCallback(async (node: Node) => {
    // Don't add if already in the list
    if (allowedClasses.some(c => c.id === node.id)) return;
    
    try {
      await addClassFilter(property.id, node.id);
      
      // Update local state
      setAllowedClasses(prev => [...prev, node]);
      
      // Update property with new class_filters
      const updatedProperty: Property = {
        ...property,
        class_filters: [...property.class_filters, node.id],
      };
      onUpdate(updatedProperty);
      setError(null);
    } catch (err) {
      setError('Failed to add class filter');
      console.error(err);
    }
  }, [property, allowedClasses, onUpdate]);
  
  const handleRemoveAllowedClass = useCallback(async (nodeId: number) => {
    try {
      await removeClassFilter(property.id, nodeId);
      
      // Update local state
      setAllowedClasses(prev => prev.filter(c => c.id !== nodeId));
      
      // Update property with removed class_filter
      const updatedProperty: Property = {
        ...property,
        class_filters: property.class_filters.filter(id => id !== nodeId),
      };
      onUpdate(updatedProperty);
      setError(null);
    } catch (err) {
      setError('Failed to remove class filter');
      console.error(err);
    }
  }, [property, onUpdate]);
  
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
          data: { multi: newIsMulti },
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
        data: { multi: false },
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
  
  return (
    <div className="property-config-section">
      {/* Scope Display (for local properties only) */}
      {isLocal && property.node_id && (
        <div className="property-config-section__scope">
          <span className="property-config-section__scope-label">Applies to </span>
          <button
            type="button"
            className="property-config-section__scope-link"
            onClick={() => {
              if (property.node_id) openNode(property.node_id);
            }}
          >
            Page #{property.node_id}
          </button>
        </div>
      )}
      
      {/* Icon visibility setting - only for selection properties */}
      {ICON_VISIBILITY_PROPERTY_TYPES.includes(property.type) && (
        <div className="property-form__field">
          <label htmlFor="property-icon-visibility" className="property-form__label">
            Value icon display
          </label>
          <SelectionButton
            id="property-icon-visibility"
            options={[
              { value: 'hidden' as PropertyIconVisibility, icon: "mdi mdi-eye-off", label: 'Hidden' },
              { value: 'after_bullet' as PropertyIconVisibility, icon: "mdi mdi-circle-small", label: 'After bullet' },
              { value: 'before_content' as PropertyIconVisibility, icon: "mdi mdi-text-box-outline", label: 'Before text' },
            ]}
            value={property.icon_visibility}
            onChange={async (value) => {
              try {
                const updated = await updatePropertyMutation.mutateAsync({
                  id: property.id,
                  data: { icon_visibility: value as PropertyIconVisibility },
                });
                onUpdate(updated);
              } catch {
                setError('Failed to update icon visibility');
              }
            }}
            size="md"
          />
        </div>
      )}

      {/* Validation rules - for text, integer, float, url, email */}
      {['text', 'integer', 'float', 'url', 'email'].includes(property.type) && (
        <ValidationRulesSection
          property={property}
          onUpdate={onUpdate}
          onError={setError}
        />
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
        onOptionIconChange={handleUpdateSelectionOptionIcon}
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
        showMultiValueSelection={false}
      />
      
      {error && (
        <div className="property-config-section__error">
          {error}
        </div>
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

/**
 * ValidationRulesSection - inline editor for property.validation_rules
 */
function ValidationRulesSection({
  property,
  onUpdate,
  onError,
}: {
  property: Property;
  onUpdate: (p: Property) => void;
  onError: (msg: string | null) => void;
}) {
  const updatePropertyMutation = useUpdateProperty();
  const rules = property.validation_rules ?? {};
  const baseId = useId();
  const minId = `${baseId}-min`;
  const maxId = `${baseId}-max`;
  const patternId = `${baseId}-pattern`;

  const save = useCallback(async (newRules: Record<string, unknown>) => {
    const cleaned = Object.fromEntries(
      Object.entries(newRules).filter(([, v]) => v !== '' && v !== null && v !== undefined)
    );
    try {
      const updated = await updatePropertyMutation.mutateAsync({
        id: property.id,
        data: { validation_rules: Object.keys(cleaned).length ? cleaned : null },
      });
      onUpdate(updated);
      onError(null);
    } catch {
      onError('Failed to update validation rules');
    }
  }, [property.id, updatePropertyMutation, onUpdate, onError]);

  if (property.type === 'integer' || property.type === 'float') {
    return (
      <div className="property-form__field">
        <span className="property-form__label">Validation</span>
        <div className="property-config-section__validation-row">
          <label htmlFor={minId} className="property-config-section__validation-inline-label">Min</label>
          <TextField
            id={minId}
            type="number"
            value={rules.min != null ? String(rules.min) : ''}
            step={property.type === 'float' ? 'any' : 1}
            onChange={(e) => {
              const v = e.target.value;
              save({ ...rules, min: v ? Number(v) : null });
            }}
            placeholder="No min"
            size="sm"
          />
          <label htmlFor={maxId} className="property-config-section__validation-inline-label">Max</label>
          <TextField
            id={maxId}
            type="number"
            value={rules.max != null ? String(rules.max) : ''}
            step={property.type === 'float' ? 'any' : 1}
            onChange={(e) => {
              const v = e.target.value;
              save({ ...rules, max: v ? Number(v) : null });
            }}
            placeholder="No max"
            size="sm"
          />
        </div>
      </div>
    );
  }

  // text, url, email — regex pattern
  return (
    <div className="property-form__field">
      <label htmlFor={patternId} className="property-form__label">Validation pattern</label>
      <TextField
        id={patternId}
        type="text"
        value={typeof rules.pattern === 'string' ? rules.pattern : ''}
        onChange={(e) => save({ ...rules, pattern: e.target.value || null })}
        placeholder={property.type === 'url' ? 'https?://.*' : property.type === 'email' ? '.+@.+\\..+' : 'Regex pattern'}
      />
    </div>
  );
}
