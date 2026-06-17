/**
 * Class Property Mutation Hooks
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';

export function useAddPropertyToClass() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ classId, propertyId }: { classId: number; propertyId: number }) =>
      propertiesApi.addClassProperty(classId, propertyId),
    onSuccess: (_, { classId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClass(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.details() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContents() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(classId) });
    },
  });
}

export function useRemovePropertyFromClass() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ classId, propertyId }: { classId: number; propertyId: number }) =>
      propertiesApi.removeClassProperty(classId, propertyId),
    onSuccess: (_, { classId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClass(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.details() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContents() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(classId) });
    },
  });
}

export function useReorderClassProperties() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ classId, propertyIds }: { classId: number; propertyIds: number[] }) =>
      propertiesApi.reorderClassProperties(classId, propertyIds),
    onSuccess: (_, { classId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClass(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.details() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContents() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(classId) });
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
      classId: number;
      propertyId: number;
      data: { required?: boolean; hidden?: boolean };
    }) => propertiesApi.updateClassProperty(classId, propertyId, data),
    onSuccess: (_, { classId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClass(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.details() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContents() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(classId) });
    },
  });
}

export function useAddClassExtends() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ classId, extendsClassId }: { classId: number; extendsClassId: number }) =>
      propertiesApi.addClassExtends(classId, extendsClassId),
    onSuccess: (_, { classId, extendsClassId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.classExtends(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.extendedByClasses(extendsClassId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
}

export function useRemoveClassExtends() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ classId, extendsClassId }: { classId: number; extendsClassId: number }) =>
      propertiesApi.removeClassExtends(classId, extendsClassId),
    onSuccess: (_, { classId, extendsClassId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.classExtends(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.extendedByClasses(extendsClassId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
}
