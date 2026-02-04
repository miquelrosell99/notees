/**
 * useDndSensors Hook
 * 
 * Provides consistent sensor configuration for drag-and-drop across the app.
 * Handles mouse, touch, and keyboard interactions.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  useSensor,
  useSensors,
  PointerSensor,
  KeyboardSensor,
  TouchSensor,
  type SensorDescriptor,
  type SensorOptions,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { DragSensorConfig } from '@/types/dnd';

/**
 * Default sensor configuration
 */
const DEFAULT_CONFIG: DragSensorConfig = {
  pointer: {
    distance: 8, // Prevent accidental drags on click
  },
  keyboard: true,
  touch: {
    delay: 250, // Delay to differentiate from scroll
    tolerance: 5,
  },
};

/**
 * Create sensors for drag-and-drop with consistent configuration
 * 
 * @param config - Optional custom sensor configuration
 * @returns Configured sensors array
 * 
 * @example
 * ```tsx
 * function MyComponent() {
 *   const sensors = useDndSensors();
 *   
 *   return (
 *     <DndContext sensors={sensors}>
 *       {children}
 *     </DndContext>
 *   );
 * }
 * ```
 * 
 * @example Custom config (no touch delay)
 * ```tsx
 * const sensors = useDndSensors({
 *   touch: { delay: 0, tolerance: 0 }
 * });
 * ```
 */
export function useDndSensors(config: DragSensorConfig = {}): SensorDescriptor<SensorOptions>[] {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Build sensors array based on config
  return useSensors(
    useSensor(PointerSensor, {
      activationConstraint: mergedConfig.pointer as any,
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
    useSensor(TouchSensor, {
      activationConstraint: mergedConfig.touch as any,
    })
  );
}

/**
 * Sensors for immediate drag (no activation delay)
 * Useful for drag handles where intent is clear
 */
export function useImmediateDndSensors(): SensorDescriptor<SensorOptions>[] {
  return useDndSensors({
    pointer: { distance: 0 },
    touch: { delay: 0, tolerance: 0 },
  });
}

/**
 * Sensors for tree/nested structures
 * Slightly higher activation threshold to prevent accidental drags during selection
 */
export function useTreeDndSensors(): SensorDescriptor<SensorOptions>[] {
  return useDndSensors({
    pointer: { distance: 10 },
    touch: { delay: 300, tolerance: 8 },
  });
}
