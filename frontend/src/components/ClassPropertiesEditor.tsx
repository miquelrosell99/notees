/**
 * ClassPropertiesEditor - Component for editing which properties a Class has
 * 
 * This allows defining which properties nodes with this class will have.
 * Properties defined here are separate from inherited properties.
 * 
 * UI matches the Class properties definition style with:
 * - Property name on left
 * - "Add description" placeholder on right
 * - Bullet before value area
 */
import { useState, useCallback } from 'react';
import './ClassPropertiesEditor.css';
import { 
  useClassProperties, 
  useAddPropertyToClass, 
  useRemovePropertyFromClass,
  useProperties 
} from '@/hooks';
import { mdiPlus } from '@mdi/js';
import { Button } from './core/Button';
import './PropertiesSection.css';

interface ClassPropertiesEditorProps {
  /** The class node ID being edited */
  classNodeId: number;
  /** Optional className for styling */
  className?: string;
  /** Whether the editor is read-only */
  readOnly?: boolean;
}

/**
 * Editor for managing properties on a class
 */
export function ClassPropertiesEditor({
  classNodeId,
  className = '',
  readOnly = false,
}: ClassPropertiesEditorProps) {
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Fetch current class properties (direct only, not inherited)
  const { data: classProperties, isLoading } = useClassProperties(classNodeId, false);
  
  // Fetch all available properties
  const { data: allProperties } = useProperties();
  
  // Mutations
  const addPropertyMutation = useAddPropertyToClass();
  const removePropertyMutation = useRemovePropertyFromClass();
  
  // Filter available properties (exclude already added)
  const availableProperties = allProperties?.filter(prop => {
    if (classProperties?.some(cp => cp.property_id === prop.id)) return false;
    if (searchQuery && !prop.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  }) ?? [];
  
  const handleAddProperty = useCallback((propertyId: number) => {
    addPropertyMutation.mutate(
      { classId: classNodeId, propertyId },
      {
        onSuccess: () => {
          setIsAddingNew(false);
          setSearchQuery('');
        },
      }
    );
  }, [classNodeId, addPropertyMutation]);
  
  const handleRemoveProperty = useCallback((propertyId: number) => {
    removePropertyMutation.mutate({ classId: classNodeId, propertyId });
  }, [classNodeId, removePropertyMutation]);
  
  if (isLoading) {
    return <div className={`properties-view class-definition-variant loading ${className}`}>Loading...</div>;
  }
  
  return (
    <div className={`properties-view class-definition-variant ${className}`}>
      <h4 className="class-properties-section-title">
        Class Properties
      </h4>
      <p className="class-properties-description">
        Class properties are inherited by all nodes with this class. For example, each @Task node inherits 'Status' and 'Priority'.
      </p>
      
      {/* Current properties list */}
      <div className="class-properties-list">
        {classProperties && classProperties.length > 0 ? (
          classProperties.map((cp) => (
            <div key={cp.id} className="class-property-definition-row">
              <label className="class-property-definition-label">
                {cp.property_name}
              </label>
              <div className="class-property-definition-value">
                <span className="class-property-placeholder">Add description</span>
                {!readOnly && (
                  <Button
                    className="class-property-remove-btn"
                    variant="ghost"
                    size="xs"
                    onClick={() => handleRemoveProperty(cp.property_id)}
                    disabled={removePropertyMutation.isPending}
                    title="Remove property from class"
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
            <div className="class-properties-picker">
              <input
                type="text"
                className="class-properties-search"
                placeholder="Search properties..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
              />
              <div className="class-properties-options">
                {availableProperties.slice(0, 10).map((prop) => (
                  <Button
                    key={prop.id}
                    className="class-property-option"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleAddProperty(prop.id)}
                    disabled={addPropertyMutation.isPending}
                  >
                    {prop.icon && <span>{prop.icon}</span>}
                    {prop.name}
                    <span className="class-property-type">({prop.type})</span>
                  </Button>
                ))}
                {availableProperties.length === 0 && (
                  <p className="class-properties-no-results">
                    {allProperties?.length === 0 
                      ? 'No properties exist. Create a property first.'
                      : 'No matching properties found'}
                  </p>
                )}
              </div>
              <Button
                className="class-properties-cancel"
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
            <Button
              icon={mdiPlus}
              className="properties-add-btn"
              onClick={() => setIsAddingNew(true)}
              title="Add property"
              size="sm"
              variant="ghost"
            >
              Add property
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default ClassPropertiesEditor;
