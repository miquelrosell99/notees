/**
 * Favorites server state via TanStack Query.
 *
 * Provides query/mutation hooks for components and imperative helpers
 * for non-component code (mutation callbacks, dynamic imports, etc.).
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { queryClient } from '@/lib/queryClient';
import { favoriteKeys } from './queryKeys';

export function useFavorites() {
  return useQuery<number[], Error>({
    queryKey: favoriteKeys.list(),
    queryFn: () =>
      nodesApi.getFavorites(1, 50).then((response) => response.items.map((node) => node.id)),
  });
}

export function useAddFavoriteMutation() {
  const qc = useQueryClient();
  return useMutation<number[], Error, number>({
    mutationFn: nodesApi.addFavorite,
    onSuccess: (data) => {
      qc.setQueryData<number[]>(favoriteKeys.list(), data);
      qc.invalidateQueries({ queryKey: favoriteKeys.all });
    },
  });
}

export function useRemoveFavoriteMutation() {
  const qc = useQueryClient();
  return useMutation<number[], Error, number>({
    mutationFn: nodesApi.removeFavorite,
    onSuccess: (data) => {
      qc.setQueryData<number[]>(favoriteKeys.list(), data);
      qc.invalidateQueries({ queryKey: favoriteKeys.all });
    },
  });
}

export function useReorderFavoritesMutation() {
  const qc = useQueryClient();
  return useMutation<number[], Error, { fromIndex: number; toIndex: number }>({
    mutationFn: ({ fromIndex, toIndex }) => nodesApi.reorderFavorites(fromIndex, toIndex),
    onSuccess: (data) => {
      qc.setQueryData<number[]>(favoriteKeys.list(), data);
      qc.invalidateQueries({ queryKey: favoriteKeys.all });
    },
  });
}

export async function addFavorite(nodeId: number): Promise<number[]> {
  const data = await nodesApi.addFavorite(nodeId);
  queryClient.setQueryData<number[]>(favoriteKeys.list(), data);
  queryClient.invalidateQueries({ queryKey: favoriteKeys.all });
  return data;
}

export async function removeFavorite(nodeId: number): Promise<number[]> {
  const data = await nodesApi.removeFavorite(nodeId);
  queryClient.setQueryData<number[]>(favoriteKeys.list(), data);
  queryClient.invalidateQueries({ queryKey: favoriteKeys.all });
  return data;
}

export async function reorderFavorites(fromIndex: number, toIndex: number): Promise<number[]> {
  const data = await nodesApi.reorderFavorites(fromIndex, toIndex);
  queryClient.setQueryData<number[]>(favoriteKeys.list(), data);
  queryClient.invalidateQueries({ queryKey: favoriteKeys.all });
  return data;
}

export function isFavorite(nodeId: number): boolean {
  const favorites = queryClient.getQueryData<number[]>(favoriteKeys.list());
  return favorites?.includes(nodeId) ?? false;
}
