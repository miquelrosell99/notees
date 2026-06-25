/**
 * Property Mutation Hooks
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import type { PropertyCreate, PropertyIconVisibility } from '@/types/api';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import { resolvePropertyUuid } from '@/utils/resolveNodeUuid';

export function useCreateProperty() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: PropertyCreate) =>
      propertiesApi.createProperty(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.lists() });
    },
  });
}

export function useUpdateProperty() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string | number; data: { name?: string; icon?: string; multi?: boolean; icon_visibility?: PropertyIconVisibility | null; validation_rules?: Record<string, unknown> | null } }) => {
      const propertyUuid = typeof id === 'string' ? id : resolvePropertyUuid(id);
      if (!propertyUuid) throw new Error(`Unable to resolve UUID for property id ${id}`);
      return propertiesApi.updateProperty(propertyUuid, data);
    },
    onSuccess: (updated, { id }) => {
      const propertyUuid = typeof id === 'string' ? id : resolvePropertyUuid(id);
      if (propertyUuid) {
        queryClient.setQueryData(propertyKeys.detail(propertyUuid), updated);
      }
      queryClient.invalidateQueries({ queryKey: propertyKeys.lists() });
    },
  });
}

export function useDeleteProperty() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string | number) => {
      const propertyUuid = typeof id === 'string' ? id : resolvePropertyUuid(id);
      if (!propertyUuid) throw new Error(`Unable to resolve UUID for property id ${id}`);
      return propertiesApi.deleteProperty(propertyUuid);
    },
    onSuccess: (_, id) => {
      const propertyUuid = typeof id === 'string' ? id : resolvePropertyUuid(id);
      if (propertyUuid) {
        queryClient.removeQueries({ queryKey: propertyKeys.detail(propertyUuid) });
      }
      queryClient.invalidateQueries({ queryKey: propertyKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
}
