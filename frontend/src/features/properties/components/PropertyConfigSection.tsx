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
import type { Property, Node, PropertyIconVisibility, PropertyUpdate, SelectionOption } from '@/types/api';
import { ICON_VISIBILITY_PROPERTY_TYPES } from '@/types/api';
import { parseIconField } from '@/utils/iconDom';
import { useUpdateProperty } from '../hooks';
import { useClasses } from '@/features/content';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { useParams } from 'react-router-dom';
import { uuidv7 } from '@/core/uuid';
import { useNavigationStore } from '@/stores';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { TextField } from '@/components/ui/TextField';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { BooleanToggle } from '@/components/ui/BooleanToggle';
import { PropertyForm } from './PropertyForm';
import { DefaultValueEditor } from './DefaultValueEditor';
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
  const openNode = useNavigationStore(state => state.openNode);
  const [newOptionName, setNewOptionName] = useState('');
  const [newOptionIcon, setNewOptionIcon] = useState('');
  const [showAddOption, setShowAddOption] = useState(false);
  const [allowedClasses, setAllowedClasses] = useState<Node[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');

  // Mutations
  const updatePropertyMutation = useUpdateProperty();
  
  // Get all classes to resolve class_filter_uuids to Node objects
  const { data: allClasses } = useClasses();
  
  // Sync isMultiValue with property.multi when property changes
  useEffect(() => {
    setIsMultiValue(property.multi || false);
  }, [property.multi]);
  
  // Load allowed classes from property.class_filter_uuids
  useEffect(() => {
    if (allClasses && property.class_filter_uuids) {
      const classNodes = property.class_filter_uuids
        .map(classUuid => allClasses.find(c => c.uuid === classUuid))
        .filter((c): c is Node => c !== undefined);
      setAllowedClasses(classNodes);
    }
  }, [allClasses, property.class_filter_uuids]);
  
  // Convert property options to form format (id holds the option UUID)
  const selectionOptions: SelectionOptionWithId[] = useMemo(() =>
    (property.options || []).map(opt => ({
      id: opt.uuid,
      name: opt.name,
      icon: opt.icon || undefined,
    })),
    [property.options]
  );
  
  // Selection option handlers
  const handleAddSelectionOption = useCallback(async () => {
    if (!newOptionName.trim() || !client) return;

    const { icon: parsedIcon, color: parsedColor } = parseIconField(newOptionIcon || '');
    const newOption: SelectionOption = {
      uuid: uuidv7(),
      name: newOptionName.trim(),
      icon: parsedIcon || newOptionIcon || null,
      color: parsedColor || null,
      sequence: property.options.length,
    };
    const updatedOptions = [...property.options, newOption];

    try {
      await client.mutate<void>('updatePropertySchema', [{
        schemaId: property.uuid,
        options: updatedOptions,
      }]);

      const updatedProperty: Property = {
        ...property,
        options: updatedOptions,
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
  }, [property, newOptionName, newOptionIcon, onUpdate, client]);

  const handleRemoveSelectionOption = useCallback(async (id: string) => {
    if (!client) return;

    const updatedOptions = property.options.filter(o => o.uuid !== id);
    try {
      await client.mutate<void>('updatePropertySchema', [{
        schemaId: property.uuid,
        options: updatedOptions,
      }]);

      const updatedProperty: Property = {
        ...property,
        options: updatedOptions,
      };
      onUpdate(updatedProperty);
      setError(null);
    } catch (err) {
      setError('Failed to remove selection option');
      console.error(err);
    }
  }, [property, onUpdate, client]);

  const handleUpdateSelectionOptionIcon = useCallback(async (id: string, iconField: string) => {
    if (!client) return;

    const { icon: parsedIcon, color: parsedColor } = parseIconField(iconField);
    const updatedOptions = property.options.map(o =>
      o.uuid === id ? { ...o, icon: parsedIcon || null, color: parsedColor || null } : o
    );
    try {
      await client.mutate<void>('updatePropertySchema', [{
        schemaId: property.uuid,
        options: updatedOptions,
      }]);

      const updatedProperty: Property = {
        ...property,
        options: updatedOptions,
      };
      onUpdate(updatedProperty);
      setError(null);
    } catch (err) {
      setError('Failed to update option icon');
      console.error(err);
    }
  }, [property, onUpdate, client]);

  const handleReorderSelectionOptions = useCallback(async (reordered: SelectionOptionWithId[]) => {
    if (!client) return;

    const updatedOptions: SelectionOption[] = reordered.map((opt, index) => ({
      uuid: opt.id,
      name: opt.name,
      icon: opt.icon ?? null,
      color: null,
      sequence: index,
    }));
    try {
      await client.mutate<void>('updatePropertySchema', [{
        schemaId: property.uuid,
        options: updatedOptions,
      }]);

      const updatedProperty: Property = {
        ...property,
        options: updatedOptions,
      };
      onUpdate(updatedProperty);
    } catch (err) {
      setError('Failed to reorder options');
      console.error(err);
    }
  }, [property, onUpdate, client]);

  // Allowed class handlers
  const handleAddAllowedClass = useCallback(async (node: Node) => {
    if (!client || allowedClasses.some(c => c.uuid === node.uuid)) return;

    const updatedClassFilterUuids = [...(property.class_filter_uuids ?? []), node.uuid];
    try {
      await client.mutate<void>('updatePropertySchema', [{
        schemaId: property.uuid,
        classFilterUuids: updatedClassFilterUuids,
      }]);

      setAllowedClasses(prev => [...prev, node]);

      const updatedProperty: Property = {
        ...property,
        class_filter_uuids: updatedClassFilterUuids,
      };
      onUpdate(updatedProperty);
      setError(null);
    } catch (err) {
      setError('Failed to add class filter');
      console.error(err);
    }
  }, [property, allowedClasses, onUpdate, client]);

  const handleRemoveAllowedClass = useCallback(async (nodeUuid: string) => {
    if (!client) return;

    const updatedClassFilterUuids = (property.class_filter_uuids ?? []).filter(uuid => uuid !== nodeUuid);
    try {
      await client.mutate<void>('updatePropertySchema', [{
        schemaId: property.uuid,
        classFilterUuids: updatedClassFilterUuids,
      }]);

      setAllowedClasses(prev => prev.filter(c => c.uuid !== nodeUuid));

      const updatedProperty: Property = {
        ...property,
        class_filter_uuids: updatedClassFilterUuids,
      };
      onUpdate(updatedProperty);
      setError(null);
    } catch (err) {
      setError('Failed to remove class filter');
      console.error(err);
    }
  }, [property, allowedClasses, onUpdate, client]);
  
  // Handle multi-value change
  const handleMultiValueChange = useCallback(async (newIsMulti: boolean) => {
    // If changing from multi to single, show confirmation
    if (isMultiValue && !newIsMulti) {
      setShowMultiValueConfirm(true);
    } else {
      // Changing from single to multi is safe, no confirmation needed
      try {
        const updated = await updatePropertyMutation.mutateAsync({
          id: property.uuid,
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
        id: property.uuid,
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
      {isLocal && property.node_uuid && (
        <div className="property-config-section__scope">
          <span className="property-config-section__scope-label">Applies to </span>
          <button
            type="button"
            className="property-config-section__scope-link"
            onClick={() => {
              if (property.node_uuid) openNode(property.node_uuid);
            }}
          >
            Page
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
                  id: property.uuid,
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

      {/* Attributes - required / read-only / hide-when-empty / default value */}
      <AttributesSection
        property={property}
        onUpdate={onUpdate}
        onError={setError}
      />

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
        showDefaultValue={false}
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
 * AttributesSection - required / read-only / hide-when-empty toggles plus the
 * type-appropriate default value editor.
 */
function AttributesSection({
  property,
  onUpdate,
  onError,
}: {
  property: Property;
  onUpdate: (p: Property) => void;
  onError: (msg: string | null) => void;
}) {
  const updatePropertyMutation = useUpdateProperty();
  const defaultValueId = useId();

  const save = useCallback(async (data: PropertyUpdate) => {
    try {
      const updated = await updatePropertyMutation.mutateAsync({
        id: property.uuid,
        data,
      });
      onUpdate(updated);
      onError(null);
    } catch {
      onError('Failed to update property attributes');
    }
  }, [property.uuid, updatePropertyMutation, onUpdate, onError]);

  return (
    <div className="property-form__field">
      <span className="property-form__label">Attributes</span>
      <div className="property-config-section__attribute-toggles">
        <BooleanToggle
          size="sm"
          label="Required"
          checked={property.required}
          disabled={updatePropertyMutation.isPending}
          onChange={(e) => save({ required: e.target.checked })}
        />
        <BooleanToggle
          size="sm"
          label="Read-only"
          checked={property.readonly}
          disabled={updatePropertyMutation.isPending}
          onChange={(e) => save({ readonly: e.target.checked })}
        />
        <BooleanToggle
          size="sm"
          label="Hide when empty"
          checked={property.hide_when_empty}
          disabled={updatePropertyMutation.isPending}
          onChange={(e) => save({ hide_when_empty: e.target.checked })}
        />
      </div>
      <div className="property-config-section__attribute-default">
        <label htmlFor={defaultValueId} className="property-config-section__validation-inline-label">Default value</label>
        <DefaultValueEditor
          id={defaultValueId}
          property={property}
          value={property.default_value}
          onChange={(value) => save({ default_value: value })}
        />
      </div>
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
        id: property.uuid,
        data: { validation_rules: Object.keys(cleaned).length ? cleaned : null },
      });
      onUpdate(updated);
      onError(null);
    } catch {
      onError('Failed to update validation rules');
    }
  }, [property.uuid, updatePropertyMutation, onUpdate, onError]);

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
