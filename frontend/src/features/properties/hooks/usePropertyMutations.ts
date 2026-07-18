/**
 * Property Mutation Hooks
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import type { PropertyCreate, PropertyUpdate } from '@/types/api';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import { ENABLE_SQLITE_STORE } from '@/core/utils/featureFlags';

export function useCreateProperty() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: PropertyCreate) => {
      if (ENABLE_SQLITE_STORE) {
        throw new Error('Property schema CRUD not yet implemented in SQLite mode');
      }
      return propertiesApi.createProperty(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.lists() });
    },
  });
}

export function useUpdateProperty() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: PropertyUpdate }) => {
      if (ENABLE_SQLITE_STORE) {
        throw new Error('Property schema CRUD not yet implemented in SQLite mode');
      }
      return propertiesApi.updateProperty(id, data);
    },
    onSuccess: (updated, { id }) => {
      queryClient.setQueryData(propertyKeys.detail(id), updated);
      queryClient.invalidateQueries({ queryKey: propertyKeys.lists() });
    },
  });
}

export function useDeleteProperty() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => {
      if (ENABLE_SQLITE_STORE) {
        throw new Error('Property schema CRUD not yet implemented in SQLite mode');
      }
      return propertiesApi.deleteProperty(id);
    },
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: propertyKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
}
