export interface UndoEntry {
  forward: () => void;
  inverse: () => void;
  label: string;
  timestamp: number;
}

export type UndoEventType = 'stack_changed' | 'undo' | 'redo';

export interface UndoEvent {
  type: UndoEventType;
  entry?: UndoEntry;
}

export type UndoListener = (event: UndoEvent) => void;
