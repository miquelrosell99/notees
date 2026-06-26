/**
 * TanStack Query mutations for importing Markdown and OPML files.
 *
 * The concrete importer modules are lazy-loaded so the parser code is only
 * downloaded when a direct file import is actually executed.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  MarkdownImportRequest,
  OpmlImportRequest,
  MarkdownImportResult,
} from '../api/import';
import { nodeKeys } from '@/hooks/queryKeys';

export function useImportMarkdown() {
  const queryClient = useQueryClient();
  return useMutation<MarkdownImportResult[], Error, MarkdownImportRequest>({
    mutationFn: async (request) => {
      const { importMarkdown } = await import('../api/import');
      return importMarkdown(request);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.all });
    },
  });
}

export function useImportOpml() {
  const queryClient = useQueryClient();
  return useMutation<MarkdownImportResult[], Error, OpmlImportRequest>({
    mutationFn: async (request) => {
      const { importOpml } = await import('../api/import');
      return importOpml(request);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.all });
    },
  });
}
