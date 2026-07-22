export interface UndoEntry {
  forward: () => void;
  inverse: () => void;
  label: string;
  timestamp: number;
}

/**
 * Worker-safe subset of UndoEntry. Functions cannot be structured-cloned, so
 * only display/identity fields cross the boundary.
 */
export interface SerializableUndoEntry {
  label: string;
  timestamp: number;
}

export type UndoEventType = 'stack_changed' | 'undo' | 'redo';

export interface UndoEvent {
  type: UndoEventType;
  entry?: UndoEntry;
}

export type UndoListener = (event: UndoEvent) => void;
