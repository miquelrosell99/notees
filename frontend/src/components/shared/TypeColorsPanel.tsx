/**
 * TypeColorsPanel Component
 * 
 * Shared panel for managing type/class colors.
 * Used by both GraphView and TimelineView.
 * 
 * Features:
 * - Search to add classes
 * - Drag to reorder (first match wins)
 * - Color picker for each class
 * - Remove classes
 */
import { useState } from 'react';
import { mdiClose } from '@mdi/js';
import type { Node } from '@/types';
import { Button } from '../core/Button';
import { ColorPicker } from '../core/ColorPicker';
import { ColorButton } from '../core/ColorButton';
import { ListSortable } from '../core/ListSortable';
import './TypeColorsPanel.css';

export interface TypeColor {
  typeId: number;
  typeName: string;
  color: string;
  order: number;
}

export interface TypeColorsPanelProps {
  /** Current type colors */
  typeColors: TypeColor[];
  /** Available classes to choose from */
  classes?: Node[];
  /** Default colors for new classes */
  defaultColors?: string[];
  /** Callback when type colors change */
  onChange: (typeColors: TypeColor[]) => void;
}

const DEFAULT_TYPE_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#3b82f6', '#84cc16',
];

export function TypeColorsPanel({
  typeColors,
  classes,
  defaultColors = DEFAULT_TYPE_COLORS,
  onChange,
}: TypeColorsPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const addTypeColor = (classNode: Node) => {
    const newTypeColor: TypeColor = {
      typeId: classNode.id,
      typeName: classNode.name || 'Untitled',
      color: defaultColors[typeColors.length % defaultColors.length],
      order: typeColors.length,
    };
    onChange([...typeColors, newTypeColor]);
    setSearchQuery('');
  };

  const updateTypeColor = (typeId: number, color: string) => {
    onChange(
      typeColors.map(tc => tc.typeId === typeId ? { ...tc, color } : tc)
    );
  };

  const removeTypeColor = (typeId: number) => {
    onChange(typeColors.filter(tc => tc.typeId !== typeId));
  };

  const moveTypeColor = (fromIndex: number, toIndex: number) => {
    const newTypeColors = [...typeColors];
    const [movedItem] = newTypeColors.splice(fromIndex, 1);
    newTypeColors.splice(toIndex, 0, movedItem);
    onChange(
      newTypeColors.map((item, index) => ({
        ...item,
        order: index,
      }))
    );
  };

  const filteredClasses = classes
    ?.filter((c: Node) => 
      c.name?.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !typeColors.some(tc => tc.typeId === c.id)
    )
    .slice(0, 5);

  return (
    <div className="type-colors-panel">
      <p className="type-colors-description">
        Colors apply by priority. First match wins. Drag to reorder.
      </p>
      
      <div className="type-colors-search">
        <input
          type="text"
          placeholder="Search classes to add..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && filteredClasses && filteredClasses.length > 0 && (
          <div className="type-colors-search-results">
            {filteredClasses.map((c: Node) => (
              <Button
                key={c.id}
                variant="ghost"
                className="type-search-result"
                onClick={() => addTypeColor(c)}
              >
                {c.name || 'Untitled'}
              </Button>
            ))}
          </div>
        )}
      </div>
      
      <div className="type-colors-list">
        {typeColors.length > 0 ? (
          <ListSortable
            items={typeColors.map(tc => ({ id: tc.typeId, ...tc }))}
            onReorder={moveTypeColor}
            itemClassName="type-color-item"
            renderText={(item) => (
              <span className="type-name">{item.typeName}</span>
            )}
            renderActions={(item) => [
              <ColorPicker
                key="color"
                value={item.color}
                onChange={(color) => updateTypeColor(item.id as number, color || defaultColors[0])}
                size="xs"
                panelPosition="left"
                showNoColor={false}
                showCustom={true}
                tooltip="Change color"
                trigger={
                  <ColorButton
                    color={item.color}
                    size="xs"
                    title="Change color"
                  />
                }
              />,
              <Button
                key="remove"
                icon={mdiClose}
                size="xs"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTypeColor(item.id as number);
                }}
                title="Remove class"
              />
            ]}
          />
        ) : (
          <p className="no-types">Search to add classes</p>
        )}
      </div>
    </div>
  );
}
