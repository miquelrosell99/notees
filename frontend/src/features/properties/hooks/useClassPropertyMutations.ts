/**
 * Class Property Mutation Hooks
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { nodeKeys, propertyKeys, nodeViewKeys } from '@/hooks/queryKeys';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import type {
  ClassPropertyEdgeCreatePayload,
  ClassPropertyEdgeDeletePayload,
  ClassPropertyEdgeReorderPayload,
  ClassPropertyEdgeUpdatePayload,
} from '@/core/types/operation';

function useClient() {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  return useWorkspaceStoreClient(workspaceId ?? '');
}

function resolveClassId(classId: string): string {
  return classId;
}

function resolvePropertyId(propertyId: string): string {
  return propertyId;
}

function invalidateClassQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  classId: string
) {
  queryClient.invalidateQueries({ queryKey: propertyKeys.forClass(classId) });
  queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
  queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(classId) });
}

export function useAddPropertyToClass() {
  const queryClient = useQueryClient();
  const { client } = useClient();

  return useMutation<void, Error, { classId: string; propertyId: string }>({
    mutationFn: async ({ classId, propertyId }) => {
      if (!client) throw new Error('Workspace store not available');
      const payload: ClassPropertyEdgeCreatePayload = {
        classId: resolveClassId(classId),
        propertySchemaId: resolvePropertyId(propertyId),
      };
      await client.mutate<void>('addPropertyToClass', [payload]);
    },
    onSuccess: (_, { classId }) => {
      invalidateClassQueries(queryClient, classId);
      queryClient.invalidateQueries({ queryKey: nodeKeys.details() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContents() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
}

export function useRemovePropertyFromClass() {
  const queryClient = useQueryClient();
  const { client } = useClient();

  return useMutation<void, Error, { classId: string; propertyId: string }>({
    mutationFn: async ({ classId, propertyId }) => {
      if (!client) throw new Error('Workspace store not available');
      const payload: ClassPropertyEdgeDeletePayload = {
        classId: resolveClassId(classId),
        propertySchemaId: resolvePropertyId(propertyId),
      };
      await client.mutate<void>('removePropertyFromClass', [payload]);
    },
    onSuccess: (_, { classId }) => {
      invalidateClassQueries(queryClient, classId);
      queryClient.invalidateQueries({ queryKey: nodeKeys.details() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContents() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
}

export function useReorderClassProperties() {
  const queryClient = useQueryClient();
  const { client } = useClient();

  return useMutation<void, Error, { classId: string; propertyIds: string[] }>({
    mutationFn: async ({ classId, propertyIds }) => {
      if (!client) throw new Error('Workspace store not available');
      const payload: ClassPropertyEdgeReorderPayload = {
        classId: resolveClassId(classId),
        orderedPropertySchemaIds: propertyIds.map(resolvePropertyId),
      };
      await client.mutate<void>('reorderClassProperties', [payload]);
    },
    onSuccess: (_, { classId }) => {
      invalidateClassQueries(queryClient, classId);
      queryClient.invalidateQueries({ queryKey: nodeKeys.details() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContents() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
}

export function useUpdateClassProperty() {
  const queryClient = useQueryClient();
  const { client } = useClient();

  return useMutation<
    void,
    Error,
    {
      classId: string;
      propertyId: string;
      data: {
        required?: boolean | null;
        hidden?: boolean;
        readonly?: boolean | null;
        hide_when_empty?: boolean | null;
        default_value?: unknown | null;
      };
    }
  >({
    mutationFn: async ({ classId, propertyId, data }) => {
      if (!client) throw new Error('Workspace store not available');
      const payload: ClassPropertyEdgeUpdatePayload = {
        classId: resolveClassId(classId),
        propertySchemaId: resolvePropertyId(propertyId),
        required: data.required,
        hidden: data.hidden,
        readonly: data.readonly,
        hideWhenEmpty: data.hide_when_empty,
        defaultValue: data.default_value,
      };
      await client.mutate<void>('updateClassProperty', [payload]);
    },
    onSuccess: (_, { classId }) => {
      invalidateClassQueries(queryClient, classId);
      queryClient.invalidateQueries({ queryKey: nodeKeys.details() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContents() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
}

export function useAddClassExtends() {
  const queryClient = useQueryClient();
  const { client } = useClient();

  return useMutation<void, Error, { classId: string; extendsClassId: string }>({
    mutationFn: async ({ classId, extendsClassId }) => {
      if (!client) throw new Error('Workspace store not available');
      const rows = await client.query<Array<{ ancestor_id: string }>>('getClassExtends', [classId, []]);
      const existing = new Set(rows.map((r) => r.ancestor_id));
      existing.add(extendsClassId);
      await client.mutate<void>('updateClass', [classId, Array.from(existing)]);
    },
    onSuccess: (_, { classId, extendsClassId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.classExtends(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.extendedByClasses(extendsClassId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
}

export function useRemoveClassExtends() {
  const queryClient = useQueryClient();
  const { client } = useClient();

  return useMutation<void, Error, { classId: string; extendsClassId: string }>({
    mutationFn: async ({ classId, extendsClassId }) => {
      if (!client) throw new Error('Workspace store not available');
      const rows = await client.query<Array<{ ancestor_id: string }>>('getClassExtends', [classId, []]);
      const existing = new Set(rows.map((r) => r.ancestor_id));
      existing.delete(extendsClassId);
      await client.mutate<void>('updateClass', [classId, Array.from(existing)]);
    },
    onSuccess: (_, { classId, extendsClassId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.classExtends(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.extendedByClasses(extendsClassId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
}
