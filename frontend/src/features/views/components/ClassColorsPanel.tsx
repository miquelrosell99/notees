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
import { useMemo } from 'react';
import type { Node } from '@/types';
import { nodeNameToText } from '@/features/queries';
import { Button } from '@/components/ui/Button';
import { ColorButton } from '@/components/ui/ColorButton';
import { ListSortable } from '@/components/ui/ListSortable';
import { NodeSearchBox } from '@/features/content';
import './ClassColorsPanel.css';

import { getClassColorPalette } from '@/features/views/types/viewTypes';

export interface ClassColor {
  classId: number;
  className: string;
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

export function ClassColorsPanel({
  classColors,
  defaultColors,
  onChange,
}: ClassColorsPanelProps) {
  const resolvedDefaults = useMemo(() => defaultColors ?? getClassColorPalette(), [defaultColors]);
  const addClassColor = (classNode: Node) => {
    const converted = nodeNameToText(classNode.name);
    const newClassColor: ClassColor = {
      classId: classNode.id,
      className: converted || 'Untitled',
      color: resolvedDefaults[classColors.length % resolvedDefaults.length],
      order: classColors.length,
    };
    onChange([...classColors, newClassColor]);
  };

  const updateClassColor = (classId: number, color: string) => {
    onChange(
      classColors.map(cc => cc.classId === classId ? { ...cc, color } : cc)
    );
  };

  const removeClassColor = (classId: number) => {
    onChange(classColors.filter(cc => cc.classId !== classId));
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
        <NodeSearchBox
          placeholder="Search classes to add..."
          filterFn={(node) =>
            node.is_class === true &&
            !classColors.some(cc => cc.classId === node.id)
          }
          onSelect={addClassColor}
        />
      </div>
      
      <div className="class-colors-list">
        {classColors.length > 0 ? (
          <ListSortable
            items={classColors.map(cc => ({ id: cc.classId, ...cc }))}
            onReorder={moveClassColor}
            itemClassName="class-color-item"
            renderText={(item) => (
              <span className="class-name">{item.className}</span>
            )}
            renderActions={(item) => [
              <ColorButton
                key="color"
                color={item.color}
                size="xs"
                showPicker
                onColorChange={(color) => color && updateClassColor(item.id as number, color)}
                title="Change color"
              />,
              <Button aria-label="Remove class"
                key="remove"
                icon={"mdi mdi-close"}
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
