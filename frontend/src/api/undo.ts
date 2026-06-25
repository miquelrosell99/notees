import api from '@/api/client';

export interface UndoResult {
  operation: string;
  entity_type: string;
  entity_id: number;
  description: string;
}

export interface UndoStackEntry {
  id: number;
  uuid: string;
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

export async function undoTo(entryIdOrUuid: number | string): Promise<UndoResult[]> {
  const response = await api.post<UndoResult[]>(`/undo/undo-to/${entryIdOrUuid}`);
  return response.data;
}

export async function redoTo(entryIdOrUuid: number | string): Promise<UndoResult[]> {
  const response = await api.post<UndoResult[]>(`/undo/redo-to/${entryIdOrUuid}`);
  return response.data;
}

export async function clearHistory(): Promise<void> {
  await api.delete('/undo/history');
}
