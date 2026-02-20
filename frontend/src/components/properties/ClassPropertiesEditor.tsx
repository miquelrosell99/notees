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
import { Button } from '../core/Button';
import { PropertySuggestionPopup } from './PropertySuggestionPopup';
import { NodeViewSection } from '../nodes/NodeViewSection';
import { PropertiesIcon } from '../core/icons';
import { PropertyList, type PropertyEntry } from './PropertyList';
import { useAppStore } from '@/stores';
import type { ContextMenuItem } from '../core/ContextMenu';
import type { Property } from '@/types/api';
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

  // Get openPropertyView from store
  const openPropertyView = useAppStore(state => state.openPropertyView);

  // Generate context menu items for property
  const getContextMenuItems = useCallback((property: Property): ContextMenuItem[] => {
    return [
      {
        id: 'open-property',
        label: 'Open property',
        onClick: () => {
          openPropertyView(property.id);
        },
      },
      {
        id: 'remove-property',
        label: 'Remove from class',
        danger: true,
        disabled: property.is_system,
        onClick: () => handleRemoveProperty(property.id),
      },
    ];
  }, [openPropertyView, handleRemoveProperty]);

  
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
        {/* Properties list */}
        {propertyEntries.length > 0 ? (
          <PropertyList
            properties={propertyEntries}
            readOnly={readOnly}
            showHiddenSection={true}
            renderValue={() => null}
            getContextMenuItems={getContextMenuItems}
            variant="page"
            showBullets={false}
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

