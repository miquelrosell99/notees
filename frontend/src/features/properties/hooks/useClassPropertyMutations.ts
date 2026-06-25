/**
 * Class Property Mutation Hooks
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import { nodeKeys, propertyKeys, nodeViewKeys } from '@/hooks/queryKeys';
import { tryResolveNodeUuid, resolveNodeUuid, resolvePropertyUuid } from '@/utils/resolveNodeUuid';

function resolveClassId(classId: string | number): string {
  return typeof classId === 'string' ? classId : resolveNodeUuid(classId);
}

function resolvePropertyId(propertyId: string | number): string {
  if (typeof propertyId === 'string') return propertyId;
  const uuid = resolvePropertyUuid(propertyId);
  if (!uuid) throw new Error(`Unable to resolve UUID for property id ${propertyId}`);
  return uuid;
}

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
      propertiesApi.addClassProperty(resolveClassId(classId), resolvePropertyId(propertyId)),
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
      propertiesApi.removeClassProperty(resolveClassId(classId), resolvePropertyId(propertyId)),
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
      propertiesApi.reorderClassProperties(resolveClassId(classId), propertyIds.map(resolvePropertyId)),
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
    }) => propertiesApi.updateClassProperty(resolveClassId(classId), resolvePropertyId(propertyId), data),
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
      propertiesApi.addClassExtends(resolveClassId(classId), resolveClassId(extendsClassId)),
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
      propertiesApi.removeClassExtends(resolveClassId(classId), resolveClassId(extendsClassId)),
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
