/**
 * Class Property Mutation Hooks
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { nodeKeys, propertyKeys, nodeViewKeys } from '@/hooks/queryKeys';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { queryAll } from '@/core/db/sqlite';
import type {
  ClassPropertyEdgeCreatePayload,
  ClassPropertyEdgeDeletePayload,
  ClassPropertyEdgeReorderPayload,
  ClassPropertyEdgeUpdatePayload,
} from '@/core/types/operation';

function useStore() {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  return useWorkspaceStore(workspaceId ?? '').store;
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
  const store = useStore();

  return useMutation<void, Error, { classId: string; propertyId: string }>({
    mutationFn: async ({ classId, propertyId }) => {
      if (!store) throw new Error('Workspace store not available');
      const payload: ClassPropertyEdgeCreatePayload = {
        classId: resolveClassId(classId),
        propertySchemaId: resolvePropertyId(propertyId),
      };
      store.addPropertyToClass(payload);
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
  const store = useStore();

  return useMutation<void, Error, { classId: string; propertyId: string }>({
    mutationFn: async ({ classId, propertyId }) => {
      if (!store) throw new Error('Workspace store not available');
      const payload: ClassPropertyEdgeDeletePayload = {
        classId: resolveClassId(classId),
        propertySchemaId: resolvePropertyId(propertyId),
      };
      store.removePropertyFromClass(payload);
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
  const store = useStore();

  return useMutation<void, Error, { classId: string; propertyIds: string[] }>({
    mutationFn: async ({ classId, propertyIds }) => {
      if (!store) throw new Error('Workspace store not available');
      const payload: ClassPropertyEdgeReorderPayload = {
        classId: resolveClassId(classId),
        orderedPropertySchemaIds: propertyIds.map(resolvePropertyId),
      };
      store.reorderClassProperties(payload);
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
  const store = useStore();

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
      if (!store) throw new Error('Workspace store not available');
      const payload: ClassPropertyEdgeUpdatePayload = {
        classId: resolveClassId(classId),
        propertySchemaId: resolvePropertyId(propertyId),
        required: data.required,
        hidden: data.hidden,
        readonly: data.readonly,
        hideWhenEmpty: data.hide_when_empty,
        defaultValue: data.default_value,
      };
      store.updateClassProperty(payload);
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
  const store = useStore();

  return useMutation<void, Error, { classId: string; extendsClassId: string }>({
    mutationFn: async ({ classId, extendsClassId }) => {
      if (!store) throw new Error('Workspace store not available');
      const db = store.getDb();
      const rows = queryAll<{ ancestor_id: string }>(
        db,
        'SELECT ancestor_id FROM class_hierarchy WHERE class_id = ? AND ancestor_id != ?',
        [classId, classId]
      );
      const existing = new Set(rows.map((r) => r.ancestor_id));
      existing.add(extendsClassId);
      store.updateClass(classId, Array.from(existing));
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
  const store = useStore();

  return useMutation<void, Error, { classId: string; extendsClassId: string }>({
    mutationFn: async ({ classId, extendsClassId }) => {
      if (!store) throw new Error('Workspace store not available');
      const db = store.getDb();
      const rows = queryAll<{ ancestor_id: string }>(
        db,
        'SELECT ancestor_id FROM class_hierarchy WHERE class_id = ? AND ancestor_id != ?',
        [classId, classId]
      );
      const existing = new Set(rows.map((r) => r.ancestor_id));
      existing.delete(extendsClassId);
      store.updateClass(classId, Array.from(existing));
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
