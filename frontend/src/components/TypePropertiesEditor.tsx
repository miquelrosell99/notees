/**
 * TypePropertiesEditor - Component for editing which properties a Type/Class has
 * 
 * This allows defining which properties nodes with this type will have.
 * Properties defined here are separate from inherited properties.
 * 
 * UI matches the Type properties definition style with:
 * - Property name on left
 * - "Add description" placeholder on right
 * - Bullet before value area
 */
import { useState, useCallback } from 'react';
import './TypePropertiesEditor.css';
import { 
  useTypeProperties, 
  useAddPropertyToType, 
  useRemovePropertyFromType,
  useProperties 
} from '@/hooks';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { ButtonAdd } from './core/ButtonAdd';
import { Button } from './core/Button';
import '@/views/PropertiesSection.css';

interface TypePropertiesEditorProps {
  /** The type node ID being edited */
  typeNodeId: number;
  /** Optional class name */
  className?: string;
  /** Whether the editor is read-only */
  readOnly?: boolean;
}

/**
 * Editor for managing properties on a type/class
 */
export function TypePropertiesEditor({
  typeNodeId,
  className = '',
  readOnly = false,
}: TypePropertiesEditorProps) {
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Fetch current type properties (direct only, not inherited)
  const { data: typeProperties, isLoading } = useTypeProperties(typeNodeId, false);
  
  // Fetch all available properties
  const { data: allProperties } = useProperties();
  
  // Mutations
  const addPropertyMutation = useAddPropertyToType();
  const removePropertyMutation = useRemovePropertyFromType();
  
  // Filter available properties (exclude already added)
  const availableProperties = allProperties?.filter(prop => {
    // Don't show system 'types' property (identified by UUID, not name)
    if (prop.uuid === SYSTEM_PROPERTY_UUIDS.types) return false;
    if (typeProperties?.some(tp => tp.property_id === prop.id)) return false;
    if (searchQuery && !prop.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  }) ?? [];
  
  const handleAddProperty = useCallback((propertyId: number) => {
    addPropertyMutation.mutate(
      { typeId: typeNodeId, propertyId },
      {
        onSuccess: () => {
          setIsAddingNew(false);
          setSearchQuery('');
        },
      }
    );
  }, [typeNodeId, addPropertyMutation]);
  
  const handleRemoveProperty = useCallback((propertyId: number) => {
    removePropertyMutation.mutate({ typeId: typeNodeId, propertyId });
  }, [typeNodeId, removePropertyMutation]);
  
  if (isLoading) {
    return <div className={`properties-view type-definition-variant loading ${className}`}>Loading...</div>;
  }
  
  return (
    <div className={`properties-view type-definition-variant ${className}`}>
      <h4 className="type-properties-section-title">
        Type Properties
      </h4>
      <p className="type-properties-description">
        Type properties are inherited by all nodes with this type. For example, each @Task node inherits 'Status' and 'Priority'.
      </p>
      
      {/* Current properties list */}
      <div className="type-properties-list">
        {typeProperties && typeProperties.length > 0 ? (
          typeProperties.map((tp) => (
            <div key={tp.id} className="type-property-definition-row">
              <label className="type-property-definition-label">
                {tp.property_name}
              </label>
              <div className="type-property-definition-value">
                <span className="type-property-placeholder">Add description</span>
                {!readOnly && (
                  <Button
                    className="type-property-remove-btn"
                    variant="ghost"
                    size="xs"
                    onClick={() => handleRemoveProperty(tp.property_id)}
                    disabled={removePropertyMutation.isPending}
                    title="Remove property from type"
                  >
                    ×
                  </Button>
                )}
              </div>
            </div>
          ))
        ) : null}
      </div>
      
      {/* Add new property */}
      {!readOnly && (
        <div className="properties-add">
          {isAddingNew ? (
            <div className="type-properties-picker">
              <input
                type="text"
                className="type-properties-search"
                placeholder="Search properties..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
              />
              <div className="type-properties-options">
                {availableProperties.slice(0, 10).map((prop) => (
                  <Button
                    key={prop.id}
                    className="type-property-option"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleAddProperty(prop.id)}
                    disabled={addPropertyMutation.isPending}
                  >
                    {prop.icon && <span>{prop.icon}</span>}
                    {prop.name}
                    <span className="type-property-type">({prop.type})</span>
                  </Button>
                ))}
                {availableProperties.length === 0 && (
                  <p className="type-properties-no-results">
                    {allProperties?.length === 0 
                      ? 'No properties exist. Create a property first.'
                      : 'No matching properties found'}
                  </p>
                )}
              </div>
              <Button
                className="type-properties-cancel"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIsAddingNew(false);
                  setSearchQuery('');
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <ButtonAdd
              className="properties-add-btn"
              onClick={() => setIsAddingNew(true)}
              title="Add property"
              size="sm"
            >
              Add property
            </ButtonAdd>
          )}
        </div>
      )}
    </div>
  );
}

export default TypePropertiesEditor;
