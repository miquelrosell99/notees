/**
 * DatePropertiesPanel Component
 * 
 * Manages visibility and colors of date properties displayed on timeline.
 * Uses SearchBox with properties table to fetch date-type properties.
 */
import { useMemo } from 'react';
import { mdiEye, mdiEyeOff, mdiClose } from '@mdi/js';
import Icon from '@mdi/react';
import type { Property } from '@/types';
import { useProperties } from '@/hooks';
import { Button } from '../core/Button';
import { ColorButton } from '../core/ColorButton';
import { SearchBox } from '../core/SearchBox';

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
    const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4'];
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
              <Icon path={prop.visible ? mdiEye : mdiEyeOff} size={0.7} />
            </Button>
            
            <ColorButton
              color={prop.color}
              size="sm"
              showPicker
              onColorChange={(color) => changeColor(prop.property, color)}
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
                <Icon path={mdiClose} size={0.6} />
              </Button>
            )}
          </div>
        ))}
      </div>
      
      <div className="date-properties-panel__add">
        <SearchBox<Property>
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