import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as flashcardsApi from '@/api/flashcards';

const flashcardKeys = {
  all: ['flashcards'] as const,
  due: () => [...flashcardKeys.all, 'due'] as const,
  stats: () => [...flashcardKeys.all, 'stats'] as const,
  byNode: (nodeId: number) => [...flashcardKeys.all, 'node', nodeId] as const,
};

export function useDueFlashcards(limit: number = 100) {
  return useQuery({
    queryKey: flashcardKeys.due(),
    queryFn: () => flashcardsApi.getDueFlashcards(limit),
    staleTime: 30_000,
  });
}

export function useFlashcardStats() {
  return useQuery({
    queryKey: flashcardKeys.stats(),
    queryFn: () => flashcardsApi.getFlashcardStats(),
    staleTime: 30_000,
  });
}

export function useFlashcardByNodeId(nodeId: number | null | undefined) {
  return useQuery({
    queryKey: flashcardKeys.byNode(nodeId ?? 0),
    queryFn: () => flashcardsApi.getFlashcardByNodeId(nodeId ?? 0),
    enabled: nodeId != null && nodeId > 0,
    staleTime: 30_000,
  });
}

export function useReviewFlashcard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, grade }: { nodeId: number; grade: number }) =>
      flashcardsApi.reviewFlashcard(nodeId, grade),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: flashcardKeys.due() });
      queryClient.invalidateQueries({ queryKey: flashcardKeys.stats() });
    },
  });
}

export function useCreateFlashcard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, frontText, backText }: { nodeId: number; frontText: string; backText: string }) =>
      flashcardsApi.createFlashcard(nodeId, frontText, backText),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: flashcardKeys.stats() });
      queryClient.invalidateQueries({ queryKey: flashcardKeys.due() });
      queryClient.invalidateQueries({ queryKey: flashcardKeys.byNode(variables.nodeId) });
    },
  });
}

export function useUpdateFlashcard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, frontText, backText }: { nodeId: number; frontText: string; backText: string }) =>
      flashcardsApi.updateFlashcard(nodeId, frontText, backText),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: flashcardKeys.stats() });
      queryClient.invalidateQueries({ queryKey: flashcardKeys.due() });
      queryClient.invalidateQueries({ queryKey: flashcardKeys.byNode(variables.nodeId) });
    },
  });
}
