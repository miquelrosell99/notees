import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as flashcardsApi from '@/api/flashcards';

const flashcardKeys = {
  all: ['flashcards'] as const,
  due: () => [...flashcardKeys.all, 'due'] as const,
  stats: () => [...flashcardKeys.all, 'stats'] as const,
  byNode: (nodeUuid: string) => [...flashcardKeys.all, 'node', nodeUuid] as const,
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

export function useFlashcardByNodeId(nodeUuid: string | null | undefined) {
  return useQuery({
    queryKey: flashcardKeys.byNode(nodeUuid ?? ''),
    queryFn: () => flashcardsApi.getFlashcardByNodeId(nodeUuid ?? ''),
    enabled: nodeUuid != null && nodeUuid !== '',
    staleTime: 30_000,
  });
}

export function useReviewFlashcard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeUuid, grade }: { nodeUuid: string; grade: number }) =>
      flashcardsApi.reviewFlashcard(nodeUuid, grade),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: flashcardKeys.due() });
      queryClient.invalidateQueries({ queryKey: flashcardKeys.stats() });
    },
  });
}

export function useCreateFlashcard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeUuid, frontText, backText }: { nodeUuid: string; frontText: string; backText: string }) =>
      flashcardsApi.createFlashcard(nodeUuid, frontText, backText),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: flashcardKeys.stats() });
      queryClient.invalidateQueries({ queryKey: flashcardKeys.due() });
      queryClient.invalidateQueries({ queryKey: flashcardKeys.byNode(variables.nodeUuid) });
    },
  });
}

export function useUpdateFlashcard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeUuid, frontText, backText }: { nodeUuid: string; frontText: string; backText: string }) =>
      flashcardsApi.updateFlashcard(nodeUuid, frontText, backText),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: flashcardKeys.stats() });
      queryClient.invalidateQueries({ queryKey: flashcardKeys.due() });
      queryClient.invalidateQueries({ queryKey: flashcardKeys.byNode(variables.nodeUuid) });
    },
  });
}
