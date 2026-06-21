import api from './client';

const FLASHCARDS_BASE = '/plugins/notees.flashcards/flashcards';

export interface Flashcard {
  id: number;
  uuid: string;
  node_id: number;
  front_text: string;
  back_text: string;
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  lapses: number;
  due_date: string | null;
  last_reviewed_at: string | null;
  active: boolean;
  create_date: string;
  write_date: string;
}

export interface FlashcardStats {
  total_cards: number;
  due_now: number;
  new_cards: number;
  mature_cards: number;
}

export interface ReviewResult {
  grade: number;
  interval_days: number;
  due_date: string;
}

export async function getDueFlashcards(limit: number = 100): Promise<{ cards: Flashcard[]; total_due: number }> {
  const response = await api.get<{ cards: Flashcard[]; total_due: number }>(`${FLASHCARDS_BASE}/due`, { params: { limit } });
  return response.data;
}

export async function getFlashcardByNodeId(nodeId: number): Promise<Flashcard> {
  const response = await api.get<Flashcard>(`${FLASHCARDS_BASE}/node/${nodeId}`);
  return response.data;
}

export async function createFlashcard(nodeId: number, frontText: string, backText: string): Promise<Flashcard> {
  const response = await api.post<Flashcard>(`${FLASHCARDS_BASE}/`, {
    node_id: nodeId,
    front_text: frontText,
    back_text: backText,
  });
  return response.data;
}

export async function updateFlashcard(nodeId: number, frontText: string, backText: string): Promise<Flashcard> {
  // The backend create endpoint upserts on node_id, so updates reuse the same route.
  return createFlashcard(nodeId, frontText, backText);
}

export async function reviewFlashcard(nodeId: number, grade: number): Promise<ReviewResult> {
  const response = await api.post<ReviewResult>(`${FLASHCARDS_BASE}/node/${nodeId}/review`, { grade });
  return response.data;
}

export async function getFlashcardStats(): Promise<FlashcardStats> {
  const response = await api.get<FlashcardStats>(`${FLASHCARDS_BASE}/stats`);
  return response.data;
}
