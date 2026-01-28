/**
 * DatePropertiesPanel Component
 * 
 * Manages visibility and colors of date properties displayed on timeline.
 * Similar to TypeColorsPanel.
 */
import { useState, useMemo } from 'react';
import { mdiEye, mdiEyeOff, mdiClose, mdiPlus } from '@mdi/js';
import Icon from '@mdi/react';
import { Button } from '../core/Button';
import { ColorButton } from '../core/ColorButton';

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
  availableProperties?: Array<{ value: string; label: string }>;
}

export function DatePropertiesPanel({ 
  properties, 
  onChange,
  availableProperties = []
}: DatePropertiesPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  
  const filteredAvailable = useMemo(() => {
    if (!searchQuery) return [];
    const existingProps = new Set(properties.map(p => p.property));
    return availableProperties
      .filter(p => !existingProps.has(p.value))
      .filter(p => p.label.toLowerCase().includes(searchQuery.toLowerCase()))
      .slice(0, 5);
  }, [searchQuery, properties, availableProperties]);
  
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
  
  const addProperty = (prop: { value: string; label: string }) => {
    const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4'];
    const color = colors[properties.length % colors.length];
    onChange([
      ...properties,
      {
        property: prop.value,
        label: prop.label,
        color,
        visible: true,
        removable: true,
      },
    ]);
    setSearchQuery('');
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
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'color';
                input.value = prop.color;
                input.onchange = (e) => changeColor(prop.property, (e.target as HTMLInputElement).value);
                input.click();
              }}
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
        <input
          type="text"
          placeholder="Add date property..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="date-properties-panel__search"
        />
        {filteredAvailable.length > 0 && (
          <div className="date-properties-panel__results">
            {filteredAvailable.map((prop) => (
              <Button
                key={prop.value}
                variant="ghost"
                className="date-properties-panel__result"
                onClick={() => addProperty(prop)}
              >
                <Icon path={mdiPlus} size={0.6} />
                <span>{prop.label}</span>
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
