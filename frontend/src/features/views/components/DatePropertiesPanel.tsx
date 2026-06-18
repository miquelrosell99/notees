/**
 * DatePropertiesPanel Component
 * 
 * Manages visibility and colors of date properties displayed on timeline.
 * Uses SearchBox with properties table to fetch date-type properties.
 */
import { useMemo } from 'react';

import type { Property } from '@/types';
import { useProperties } from '@/features/properties';
import { Button } from '@/components/ui/Button';
import { ColorButton } from '@/components/ui/ColorButton';
import { NodeSearchBox } from '@/features/content';
import { getDateLanePalette } from '../types/viewTypes';
import { Icon } from '@/components/ui/icons';

export interface DatePropertyConfig {
  property: string;
  label: string;
  color: string;
  visible: boolean;
  removable: boolean;
}

interface DatePropertiesPanelProps {
  properties: DatePropertyConfig[];
  onChange: (properties: DatePropertyConfig[]) => void;
}

export function DatePropertiesPanel({ 
  properties, 
  onChange,
}: DatePropertiesPanelProps) {
  const { data: allProperties = [] } = useProperties();
  
  // Get property names that are already added
  const existingPropNames = useMemo(() => 
    new Set(properties.map(p => p.property)), 
    [properties]
  );
  
  // Search function for properties
  const searchProperties = (query: string): Property[] => {
    if (!query) return [];
    return allProperties
      .filter(p => p.name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 10);
  };
  
  const toggleVisibility = (property: string) => {
    onChange(
      properties.map(p =>
        p.property === property ? { ...p, visible: !p.visible } : p
      )
    );
  };
  
  const removeProperty = (property: string) => {
    onChange(properties.filter(p => p.property !== property));
  };
  
  const changeColor = (property: string, color: string) => {
    onChange(
      properties.map(p =>
        p.property === property ? { ...p, color } : p
      )
    );
  };
  
  const addProperty = (prop: Property) => {
    const colors = getDateLanePalette();
    const color = colors[properties.length % colors.length];
    onChange([
      ...properties,
      {
        property: prop.name,
        label: prop.name,
        color,
        visible: true,
        removable: true,
      },
    ]);
  };
  
  return (
    <div className="date-properties-panel">
      <div className="date-properties-panel__list">
        {properties.map((prop) => (
          <div key={prop.property} className="date-property-item">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => toggleVisibility(prop.property)}
              title={prop.visible ? 'Hide' : 'Show'}
            >
              <Icon path={prop.visible ? "mdi mdi-eye" : "mdi mdi-eye-off"} size={0.7} />
            </Button>
            
            <ColorButton
              color={prop.color}
              size="sm"
              showPicker
              onColorChange={(color) => color && changeColor(prop.property, color)}
              title="Change color"
            />
            
            <span className="date-property-label">{prop.label}</span>
            
            {prop.removable && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeProperty(prop.property)}
                title="Remove"
              >
                <Icon path={"mdi mdi-close"} size={0.6} />
              </Button>
            )}
          </div>
        ))}
      </div>
      
      <div className="date-properties-panel__add">
        <NodeSearchBox<Property>
          placeholder="Search date properties..."
          searchFn={searchProperties}
          filterFn={(prop: Property) => prop.type === 'date' && !existingPropNames.has(prop.name)}
          getKey={(prop: Property) => prop.id}
          renderItem={(prop: Property) => (
            <>
              {prop.icon && <Icon path={prop.icon} size={0.6} />}
              <span>{prop.name}</span>
            </>
          )}
          onSelect={addProperty}
        />
      </div>
    </div>
  );
}