/**
 * Property Mutation Hooks
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import type { Property, PropertyCreate, PropertyUpdate } from '@/types/api';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { uuidv7 } from '@/core/uuid';
import type { PropertySchemaCreatePayload, PropertySchemaUpdatePayload } from '@/core/types/operation';

function useStore() {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  return useWorkspaceStore(workspaceId ?? '').store;
}

function propertyCreateToPayload(data: PropertyCreate & { selection_options?: { name: string; icon?: string }[] }): PropertySchemaCreatePayload {
  const options: PropertySchemaCreatePayload['options'] = data.selection_options?.map((opt, index) => ({
    uuid: uuidv7(),
    name: opt.name,
    icon: opt.icon ?? null,
    color: null,
    sequence: index,
  }));

  return {
    schemaId: uuidv7(),
    name: data.name,
    icon: data.icon ?? null,
    type: data.type ?? 'text',
    multi: data.multi ?? false,
    scope: data.scope ?? 'global',
    nodeId: data.node_uuid ?? null,
    classFilterUuids: data.class_filter_uuids ?? [],
    options,
  };
}

function propertyUpdateToPayload(
  schemaId: string,
  data: PropertyUpdate
): PropertySchemaUpdatePayload {
  const payload: PropertySchemaUpdatePayload = { schemaId };
  if ('name' in data) payload.name = data.name ?? null;
  if ('icon' in data) payload.icon = data.icon ?? null;
  if ('multi' in data) payload.multi = data.multi ?? null;
  if ('class_filter_uuids' in data) payload.classFilterUuids = data.class_filter_uuids ?? null;
  if ('icon_visibility' in data) payload.iconVisibility = data.icon_visibility ?? null;
  if ('validation_rules' in data) payload.validationRules = data.validation_rules ?? null;
  if ('required' in data) payload.required = data.required ?? null;
  if ('readonly' in data) payload.readonly = data.readonly ?? null;
  if ('hide_when_empty' in data) payload.hideWhenEmpty = data.hide_when_empty ?? null;
  if ('default_value' in data) payload.defaultValue = data.default_value ?? null;
  return payload;
}

export function useCreateProperty() {
  const queryClient = useQueryClient();
  const store = useStore();

  return useMutation<Property, Error, PropertyCreate & { selection_options?: { name: string; icon?: string }[] }>({
    mutationFn: async (data) => {
      if (!store) throw new Error('Workspace store not available');
      const payload = propertyCreateToPayload(data);
      store.createPropertySchema(payload);
      // Optimistically return a minimal Property so callers can link it immediately.
      return {
        uuid: payload.schemaId,
        ...data,
        options: payload.options ?? [],
      } as unknown as Property;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.lists() });
    },
  });
}

export function useUpdateProperty() {
  const queryClient = useQueryClient();
  const store = useStore();

  return useMutation<Property, Error, { id: string; data: PropertyUpdate }>({
    mutationFn: async ({ id, data }) => {
      if (!store) throw new Error('Workspace store not available');
      store.updatePropertySchema(propertyUpdateToPayload(id, data));
      return { uuid: id, ...data } as unknown as Property;
    },
    onSuccess: (_, { id }) => {
      queryClient.setQueryData(propertyKeys.detail(id), (prev: unknown) => {
        if (!prev || typeof prev !== 'object') return prev;
        return { ...prev };
      });
      queryClient.invalidateQueries({ queryKey: propertyKeys.lists() });
    },
  });
}

export function useDeleteProperty() {
  const queryClient = useQueryClient();
  const store = useStore();

  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      if (!store) throw new Error('Workspace store not available');
      store.deletePropertySchema(id);
    },
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: propertyKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
}
