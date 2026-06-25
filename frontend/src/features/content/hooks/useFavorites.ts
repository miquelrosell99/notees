/**
 * Favorites server state via TanStack Query.
 *
 * Provides query/mutation hooks for components and imperative helpers
 * for non-component code (mutation callbacks, dynamic imports, etc.).
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { queryClient } from '@/lib/queryClient';
import { favoriteKeys } from '@/hooks/queryKeys';


export function useFavorites() {
  return useQuery<string[], Error>({
    queryKey: favoriteKeys.list(),
    queryFn: () =>
      nodesApi.getFavorites(1, 50).then((response) => response.items.map((node) => node.uuid)),
  });
}

export function useAddFavoriteMutation() {
  const qc = useQueryClient();
  return useMutation<string[], Error, string>({
    mutationFn: async (nodeUuid) => {
      return nodesApi.addFavorite(nodeUuid).then((items) => items);
    },
    onSuccess: (data) => {
      qc.setQueryData<string[]>(favoriteKeys.list(), data);
      qc.invalidateQueries({ queryKey: favoriteKeys.all });
    },
  });
}

export function useRemoveFavoriteMutation() {
  const qc = useQueryClient();
  return useMutation<string[], Error, string>({
    mutationFn: async (nodeUuid) => {
      return nodesApi.removeFavorite(nodeUuid).then((items) => items);
    },
    onSuccess: (data) => {
      qc.setQueryData<string[]>(favoriteKeys.list(), data);
      qc.invalidateQueries({ queryKey: favoriteKeys.all });
    },
  });
}

export function useReorderFavoritesMutation() {
  const qc = useQueryClient();
  return useMutation<string[], Error, { fromIndex: number; toIndex: number }>({
    mutationFn: ({ fromIndex, toIndex }) =>
      nodesApi.reorderFavorites(fromIndex, toIndex).then((items) => items),
    onSuccess: (data) => {
      qc.setQueryData<string[]>(favoriteKeys.list(), data);
      qc.invalidateQueries({ queryKey: favoriteKeys.all });
    },
  });
}

export async function addFavorite(nodeUuid: string): Promise<string[]> {
  const data = await nodesApi.addFavorite(nodeUuid);
  queryClient.setQueryData<string[]>(favoriteKeys.list(), data);
  queryClient.invalidateQueries({ queryKey: favoriteKeys.all });
  return data;
}

export async function removeFavorite(nodeUuid: string): Promise<string[]> {
  const data = await nodesApi.removeFavorite(nodeUuid);
  queryClient.setQueryData<string[]>(favoriteKeys.list(), data);
  queryClient.invalidateQueries({ queryKey: favoriteKeys.all });
  return data;
}

export async function reorderFavorites(fromIndex: number, toIndex: number): Promise<string[]> {
  const data = await nodesApi.reorderFavorites(fromIndex, toIndex);
  queryClient.setQueryData<string[]>(favoriteKeys.list(), data);
  queryClient.invalidateQueries({ queryKey: favoriteKeys.all });
  return data;
}

export function isFavorite(nodeUuid: string): boolean {
  const favorites = queryClient.getQueryData<string[]>(favoriteKeys.list());
  return favorites?.includes(nodeUuid) ?? false;
}
