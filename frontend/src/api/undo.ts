import api from './client';

export interface UndoResult {
  operation: string;
  entity_type: string;
  entity_id: number;
  description: string;
}

export interface UndoStackEntry {
  id: number;
  operation: string;
  entity_type: string;
  entity_id: number;
  description: string;
}

export interface UndoStack {
  undo_count: number;
  redo_count: number;
  undo_entries: UndoStackEntry[];
  redo_entries: UndoStackEntry[];
}

export async function undo(): Promise<UndoResult> {
  const response = await api.post<UndoResult>('/undo/undo');
  return response.data;
}

export async function redo(): Promise<UndoResult> {
  const response = await api.post<UndoResult>('/undo/redo');
  return response.data;
}

export async function getUndoStack(): Promise<UndoStack> {
  const response = await api.get<UndoStack>('/undo/stack');
  return response.data;
}

export async function undoTo(entryId: number): Promise<UndoResult[]> {
  const response = await api.post<UndoResult[]>(`/undo/undo-to/${entryId}`);
  return response.data;
}

export async function redoTo(entryId: number): Promise<UndoResult[]> {
  const response = await api.post<UndoResult[]>(`/undo/redo-to/${entryId}`);
  return response.data;
}
