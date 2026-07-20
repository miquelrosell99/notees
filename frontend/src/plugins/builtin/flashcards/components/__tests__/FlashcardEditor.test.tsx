import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { FlashcardEditor } from '../FlashcardEditor';
import type { Flashcard } from '@/api/flashcards';

const createMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../hooks/useFlashcards', () => ({
  useFlashcardByNodeId: vi.fn(),
  useCreateFlashcard: () => ({
    mutate: createMock,
    isPending: false,
  }),
}));

import { useFlashcardByNodeId } from '../../hooks/useFlashcards';

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

describe('FlashcardEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading skeleton while fetching', () => {
    (useFlashcardByNodeId as ReturnType<typeof vi.fn>).mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    const { container } = render(<FlashcardEditor nodeUuid="card-1" />, { wrapper });
    expect(container.querySelector('.flashcard-editor--loading')).toBeInTheDocument();
  });

  it('renders front and back text when a card exists', () => {
    (useFlashcardByNodeId as ReturnType<typeof vi.fn>).mockReturnValue({
      data: makeCard(),
      isLoading: false,
    });

    render(<FlashcardEditor nodeUuid="card-1" />, { wrapper });
    expect(screen.getByText('Front of card')).toBeInTheDocument();
    expect(screen.getByText('Cloze one')).toBeInTheDocument();
    expect(screen.getByText('Cloze two')).toBeInTheDocument();
  });

  it('shows create button and creates a flashcard when clicked', async () => {
    (useFlashcardByNodeId as ReturnType<typeof vi.fn>).mockReturnValue({
      data: undefined,
      isLoading: false,
    });

    render(<FlashcardEditor nodeUuid="card-1" />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: /create flashcard/i }));

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledWith({
        nodeUuid: 'card-1',
        frontText: '',
        backText: '',
      });
    });
  });

  it('does not show create button in read-only mode', () => {
    (useFlashcardByNodeId as ReturnType<typeof vi.fn>).mockReturnValue({
      data: undefined,
      isLoading: false,
    });

    render(<FlashcardEditor nodeUuid="card-1" readOnly />, { wrapper });
    expect(screen.queryByRole('button', { name: /create flashcard/i })).not.toBeInTheDocument();
  });
});
