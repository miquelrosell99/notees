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
import { useState, useCallback, useMemo } from 'react';
import './ClassPropertiesEditor.css';
import { 
  useClassProperties, 
  useAddPropertyToClass, 
  useRemovePropertyFromClass,
  useProperties 
} from '@/hooks';
import { mdiPlus } from '@mdi/js';
import { Button } from './core/Button';
import { Card } from './core/Card';
import { PropertySuggestionPopup } from './properties/PropertySuggestionPopup';
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
  const [showPropertyPopup, setShowPropertyPopup] = useState(false);
  
  // Fetch current class properties (direct only, not inherited)
  const { data: classProperties, isLoading } = useClassProperties(classNodeId, false);
  
  // Mutations
  const addPropertyMutation = useAddPropertyToClass();
  const removePropertyMutation = useRemovePropertyFromClass();
  
  // Get IDs of properties already applied to this class
  const appliedPropertyIds = useMemo(() => {
    return classProperties?.map(cp => cp.property_id) ?? [];
  }, [classProperties]);
  
  const handleAddProperty = useCallback((property: { id: number }) => {
    addPropertyMutation.mutate(
      { classId: classNodeId, propertyId: property.id },
      {
        onSuccess: () => {
          setShowPropertyPopup(false);
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
    <Card 
      variant="dashed" 
      elevation="none" 
      radius="lg" 
      paddingSize="lg"
      className={`class-properties-card ${className}`}
    >
      <h4 className="class-properties-section-title">
        Class Properties
      </h4>
      <p className="class-properties-description">
        Class properties are inherited by all nodes with this class.
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
        <div className="properties-add-wrapper">
          <Button
            icon={mdiPlus}
            className="properties-add-btn"
            onClick={() => setShowPropertyPopup(!showPropertyPopup)}
            title="Add property"
            size="sm"
            variant="ghost"
          >
            Add property
          </Button>
          <PropertySuggestionPopup
            isOpen={showPropertyPopup}
            onClose={() => setShowPropertyPopup(false)}
            onSelect={handleAddProperty}
            onCreate={() => {
              // Close popup - user will need to create property first
              setShowPropertyPopup(false);
            }}
            excludeIds={appliedPropertyIds}
          />
        </div>
      )}
    </Card>
  );
}

export default ClassPropertiesEditor;
