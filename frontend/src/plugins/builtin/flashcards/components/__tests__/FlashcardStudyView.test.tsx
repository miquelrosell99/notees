import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { FlashcardStudyView } from '../FlashcardStudyView';
import type { Flashcard } from '@/api/flashcards';

const reviewMock = vi.fn().mockResolvedValue(undefined);
const refetchMock = vi.fn();

vi.mock('../../hooks/useFlashcards', () => ({
  useDueFlashcards: vi.fn(),
  useReviewFlashcard: () => ({
    mutateAsync: reviewMock,
    isPending: false,
  }),
}));

import { useDueFlashcards } from '../../hooks/useFlashcards';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

function makeCard(overrides: Partial<Flashcard> = {}): Flashcard {
  return {
    nodeUuid: 'card-1',
    uuid: 'fc-1',
    front_text: 'Front of card',
    back_text: 'Cloze one\n\n---\n\nCloze two',
    ease_factor: 2.5,
    interval_days: 0,
    repetitions: 0,
    lapses: 0,
    due_date: null,
    last_reviewed_at: null,
    active: true,
    create_date: new Date().toISOString(),
    write_date: new Date().toISOString(),
    ...overrides,
  };
}

describe('FlashcardStudyView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the front text and hint initially', () => {
    (useDueFlashcards as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { cards: [makeCard()], total_due: 1 },
      isLoading: false,
      error: null,
      refetch: refetchMock,
    });

    render(<FlashcardStudyView />, { wrapper });
    expect(screen.getByText('Front of card')).toBeInTheDocument();
    expect(screen.getByText('Click to reveal answer')).toBeInTheDocument();
  });

  it('reveals the back text when the card is clicked', () => {
    (useDueFlashcards as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { cards: [makeCard()], total_due: 1 },
      isLoading: false,
      error: null,
      refetch: refetchMock,
    });

    render(<FlashcardStudyView />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: /flashcard, click to flip/i }));
    expect(screen.getByText('Cloze one')).toBeInTheDocument();
    expect(screen.getByText('Cloze two')).toBeInTheDocument();
  });

  it('renders empty state when no cards are due', () => {
    (useDueFlashcards as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { cards: [], total_due: 0 },
      isLoading: false,
      error: null,
      refetch: refetchMock,
    });

    render(<FlashcardStudyView />, { wrapper });
    expect(screen.getByText('No cards due')).toBeInTheDocument();
  });

  it('submits a review grade and flips back to the front', async () => {
    (useDueFlashcards as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { cards: [makeCard()], total_due: 1 },
      isLoading: false,
      error: null,
      refetch: refetchMock,
    });

    render(<FlashcardStudyView />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: /flashcard, click to flip/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Easy' }));

    await waitFor(() => {
      expect(reviewMock).toHaveBeenCalledWith({ nodeUuid: 'card-1', grade: 5 });
    });
  });
});
