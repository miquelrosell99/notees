/**
 * Class Property Mutation Hooks
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import { nodeKeys, propertyKeys, nodeViewKeys } from '@/hooks/queryKeys';
import { tryResolveNodeUuid } from '@/utils/resolveNodeUuid';

function invalidateClassQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  classId: string | number
) {
  queryClient.invalidateQueries({ queryKey: propertyKeys.forClass(classId) });
  queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
  queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(classId) });

  const classUuid = tryResolveNodeUuid(classId);
  if (classUuid && classUuid !== String(classId)) {
    queryClient.invalidateQueries({ queryKey: propertyKeys.forClass(classUuid) });
    queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classUuid) });
    queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(classUuid) });
  }
}

export function useAddPropertyToClass() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ classId, propertyId }: { classId: string | number; propertyId: string | number }) =>
      propertiesApi.addClassProperty(classId, propertyId),
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

  return useMutation({
    mutationFn: ({ classId, propertyId }: { classId: string | number; propertyId: string | number }) =>
      propertiesApi.removeClassProperty(classId, propertyId),
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

  return useMutation({
    mutationFn: ({ classId, propertyIds }: { classId: string | number; propertyIds: (string | number)[] }) =>
      propertiesApi.reorderClassProperties(classId, propertyIds),
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

  return useMutation({
    mutationFn: ({
      classId,
      propertyId,
      data,
    }: {
      classId: string | number;
      propertyId: string | number;
      data: { required?: boolean; hidden?: boolean };
    }) => propertiesApi.updateClassProperty(classId, propertyId, data),
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

  return useMutation({
    mutationFn: ({ classId, extendsClassId }: { classId: string | number; extendsClassId: string | number }) =>
      propertiesApi.addClassExtends(classId, extendsClassId),
    onSuccess: (_, { classId, extendsClassId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.classExtends(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.extendedByClasses(extendsClassId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });

      const classUuid = tryResolveNodeUuid(classId);
      if (classUuid && classUuid !== String(classId)) {
        queryClient.invalidateQueries({ queryKey: propertyKeys.classExtends(classUuid) });
        queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classUuid) });
      }
      const extendsUuid = tryResolveNodeUuid(extendsClassId);
      if (extendsUuid && extendsUuid !== String(extendsClassId)) {
        queryClient.invalidateQueries({ queryKey: propertyKeys.extendedByClasses(extendsUuid) });
      }
    },
  });
}

export function useRemoveClassExtends() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ classId, extendsClassId }: { classId: string | number; extendsClassId: string | number }) =>
      propertiesApi.removeClassExtends(classId, extendsClassId),
    onSuccess: (_, { classId, extendsClassId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.classExtends(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.extendedByClasses(extendsClassId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });

      const classUuid = tryResolveNodeUuid(classId);
      if (classUuid && classUuid !== String(classId)) {
        queryClient.invalidateQueries({ queryKey: propertyKeys.classExtends(classUuid) });
        queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classUuid) });
      }
      const extendsUuid = tryResolveNodeUuid(extendsClassId);
      if (extendsUuid && extendsUuid !== String(extendsClassId)) {
        queryClient.invalidateQueries({ queryKey: propertyKeys.extendedByClasses(extendsUuid) });
      }
    },
  });
}
