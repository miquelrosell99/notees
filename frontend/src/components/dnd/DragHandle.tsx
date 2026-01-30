/**
 * DragHandle Component
 * 
 * Reusable drag handle that can be attached to any draggable element.
 * Uses the DragHandleIcon and provides consistent styling.
 */

import { type HTMLAttributes, forwardRef } from 'react';
import { DragHandleIcon } from '../icons';
import './DragHandle.css';

export interface DragHandleProps extends HTMLAttributes<HTMLDivElement> {
  /** Size of the drag icon */
  size?: 'sm' | 'md' | 'lg';
  /** Whether to show the handle (for conditional rendering based on hover) */
  visible?: boolean;
  /** Accessible label */
  label?: string;
}

/**
 * Drag handle component with icon
 * 
 * @example
 * ```tsx
 * <DragHandle {...attributes} {...listeners} />
 * ```
 */
export const DragHandle = forwardRef<HTMLDivElement, DragHandleProps>(
  function DragHandle(
    { size = 'sm', visible = true, label = 'Drag to reorder', className = '', ...props },
    ref
  ) {
    return (
      <div
        ref={ref}
        className={`drag-handle ${visible ? 'drag-handle--visible' : ''} ${className}`}
        role="button"
        aria-label={label}
        tabIndex={-1}
        {...props}
      >
        <DragHandleIcon size={size} />
      </div>
    );
  }
);
