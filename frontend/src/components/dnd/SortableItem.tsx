/**
 * SortableItem Component
 * 
 * Generic wrapper for sortable items using @dnd-kit.
 * Handles the sortable logic and provides render props for custom rendering.
 */

import { type ReactNode, type CSSProperties } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import './SortableItem.css';

export interface SortableItemProps {
  /** Unique identifier for the item */
  id: string | number;
  /** Child render function */
  children: (props: SortableItemRenderProps) => ReactNode;
  /** Whether the item is disabled (cannot be dragged) */
  disabled?: boolean;
  /** Additional data attached to the drag operation */
  data?: unknown;
}

export interface SortableItemRenderProps {
  /** Attributes to spread on the draggable element */
  attributes: Record<string, any>;
  /** Event listeners to spread on the draggable element */
  listeners: Record<string, any> | undefined;
  /** Ref to attach to the draggable element */
  setNodeRef: (node: HTMLElement | null) => void;
  /** Transform style for the element */
  style: CSSProperties;
  /** Whether this item is currently being dragged */
  isDragging: boolean;
  /** Whether this item is active (being dragged over) */
  isOver: boolean;
  /** Ref for the drag handle (if separate from item) */
  setActivatorNodeRef: (node: HTMLElement | null) => void;
}

/**
 * Sortable item wrapper component
 * 
 * @example Basic usage
 * ```tsx
 * <SortableItem id="item-1">
 *   {({ attributes, listeners, setNodeRef, style, isDragging }) => (
 *     <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
 *       Item content
 *     </div>
 *   )}
 * </SortableItem>
 * ```
 * 
 * @example With separate drag handle
 * ```tsx
 * <SortableItem id="item-1">
 *   {({ setNodeRef, style, setActivatorNodeRef, listeners, attributes }) => (
 *     <div ref={setNodeRef} style={style}>
 *       <DragHandle ref={setActivatorNodeRef} {...attributes} {...listeners} />
 *       Item content
 *     </div>
 *   )}
 * </SortableItem>
 * ```
 */
export function SortableItem({
  id,
  children,
  disabled = false,
  data,
}: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({
    id,
    disabled,
    data: data as any,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <>
      {children({
        attributes,
        listeners,
        setNodeRef,
        setActivatorNodeRef,
        style,
        isDragging,
        isOver,
      })}
    </>
  );
}
