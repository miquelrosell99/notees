/**
 * ClassColorsPanel Component
 * 
 * Shared panel for managing class colors.
 * Used by both GraphView and TimelineView.
 * 
 * Features:
 * - SearchBox to add classes (nodes with is_class=true)
 * - Drag to reorder (first match wins)
 * - Color picker for each class
 * - Remove classes
 */
import { mdiClose } from '@mdi/js';
import type { Node } from '@/types';
import { Button } from '../core/Button';
import { ColorButton } from '../core/ColorButton';
import { ListSortable } from '../core/ListSortable';
import { SearchBox } from '../SearchBox';
import './ClassColorsPanel.css';

export interface ClassColor {
  typeId: number;
  typeName: string;
  color: string;
  order: number;
}

export interface ClassColorsPanelProps {
  /** Current class colors */
  classColors: ClassColor[];
  /** Default colors for new classes */
  defaultColors?: string[];
  /** Callback when class colors change */
  onChange: (classColors: ClassColor[]) => void;
}

const DEFAULT_CLASS_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#3b82f6', '#84cc16',
];

export function ClassColorsPanel({
  classColors,
  defaultColors = DEFAULT_CLASS_COLORS,
  onChange,
}: ClassColorsPanelProps) {
  const addClassColor = (classNode: Node) => {
    // Only allow nodes that are classes (is_class=true)
    if (!classNode.is_class) return;
    
    // Don't add duplicates
    if (classColors.some(cc => cc.typeId === classNode.id)) return;
    
    const newClassColor: ClassColor = {
      typeId: classNode.id,
      typeName: classNode.name || 'Untitled',
      color: defaultColors[classColors.length % defaultColors.length],
      order: classColors.length,
    };
    onChange([...classColors, newClassColor]);
  };

  const updateClassColor = (typeId: number, color: string) => {
    onChange(
      classColors.map(cc => cc.typeId === typeId ? { ...cc, color } : cc)
    );
  };

  const removeClassColor = (typeId: number) => {
    onChange(classColors.filter(cc => cc.typeId !== typeId));
  };

  const moveClassColor = (fromIndex: number, toIndex: number) => {
    const newClassColors = [...classColors];
    const [movedItem] = newClassColors.splice(fromIndex, 1);
    newClassColors.splice(toIndex, 0, movedItem);
    onChange(
      newClassColors.map((item, index) => ({
        ...item,
        order: index,
      }))
    );
  };

  return (
    <div className="class-colors-panel">
      <p className="class-colors-description">
        Colors apply by priority. First match wins. Drag to reorder.
      </p>
      
      <div className="class-colors-search">
        <SearchBox
          placeholder="Search classes to add..."
          onSelect={addClassColor}
        />
      </div>
      
      <div className="class-colors-list">
        {classColors.length > 0 ? (
          <ListSortable
            items={classColors.map(cc => ({ id: cc.typeId, ...cc }))}
            onReorder={moveClassColor}
            itemClassName="class-color-item"
            renderText={(item) => (
              <span className="class-name">{item.typeName}</span>
            )}
            renderActions={(item) => [
              <ColorButton
                key="color"
                color={item.color}
                size="xs"
                showPicker
                onColorChange={(color) => updateClassColor(item.id as number, color)}
                title="Change color"
              />,
              <Button
                key="remove"
                icon={mdiClose}
                size="xs"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  removeClassColor(item.id as number);
                }}
                title="Remove class"
              />
            ]}
          />
        ) : (
          <p className="no-classes">Search to add classes</p>
        )}
      </div>
    </div>
  );
}
