/**
 * ClassPropertiesEditor - Component for editing which properties a Class has
 * 
 * This allows defining which properties nodes with this class will have.
 * Properties defined here are separate from inherited properties.
 * 
 * Uses PropertyList component for consistent UI with PropertiesSection.
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
import { PropertySuggestionPopup } from './properties/PropertySuggestionPopup';
import { NodeViewSection } from './nodes/NodeViewSection';
import { PropertiesIcon } from './icons';
import { PropertyList, type PropertyEntry } from './properties/PropertyList';
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
  const { data: allProperties } = useProperties();
  
  // Mutations
  const addPropertyMutation = useAddPropertyToClass();
  const removePropertyMutation = useRemovePropertyFromClass();
  
  // Get IDs of properties already applied to this class
  const appliedPropertyIds = useMemo(() => {
    return classProperties?.map(cp => cp.property_id) ?? [];
  }, [classProperties]);

  // Convert class properties to PropertyEntry format for PropertyList
  const propertyEntries = useMemo<PropertyEntry[]>(() => {
    if (!classProperties || !allProperties) return [];
    
    return classProperties.map(cp => {
      const property = allProperties.find(p => p.id === cp.property_id);
      if (!property) return null;
      
      return {
        property,
        value: cp.default_value ?? null,
        hidden: cp.hidden,
      };
    }).filter((entry): entry is PropertyEntry => entry !== null);
  }, [classProperties, allProperties]);
  
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

  // Render value function for PropertyList
  const renderValue = useCallback((entry: PropertyEntry, readOnly: boolean) => {
    return (
      <>
        <span className="class-property-placeholder">Add description</span>
        {!readOnly && (
          <Button
            className="class-property-remove-btn"
            variant="ghost"
            size="xs"
            onClick={() => handleRemoveProperty(entry.property.id)}
            disabled={removePropertyMutation.isPending}
            title="Remove property from class"
          >
            ×
          </Button>
        )}
      </>
    );
  }, [handleRemoveProperty, removePropertyMutation.isPending]);
  
  if (isLoading) {
    return <div className={`properties-view class-definition-variant loading ${className}`}>Loading...</div>;
  }
  
  return (
    <NodeViewSection
      title="Class Properties"
      icon={<PropertiesIcon size="sm" />}
      count={propertyEntries.length}
      className={`class-properties-section ${className}`}
      defaultExpanded={true}
      hideWhenEmpty={false}
    >
      <div className="class-properties-content">
        <p className="class-properties-description">
          Class properties are inherited by all nodes with this class.
        </p>
        
        {/* Properties list */}
        {propertyEntries.length > 0 ? (
          <PropertyList
            properties={propertyEntries}
            readOnly={readOnly}
            showHiddenSection={true}
            renderValue={renderValue}
            variant="page"
            showBullets={true}
          />
        ) : (
          <p className="class-properties-empty">No properties defined yet.</p>
        )}
        
        {/* Add new property */}
        {!readOnly && (
          <div className="properties-add-wrapper">
            <Button
              icon={mdiPlus}
              className="properties-add-btn"
              onClick={() => setShowPropertyPopup(!showPropertyPopup)}
              title="Add property"
              size="xs"
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
      </div>
    </NodeViewSection>
  );
}

export default ClassPropertiesEditor;

