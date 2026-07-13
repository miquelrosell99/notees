/**
 * Class Property Mutation Hooks
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import { nodeKeys, propertyKeys, nodeViewKeys } from '@/hooks/queryKeys';


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

  return useMutation({
    mutationFn: ({ classId, propertyId }: { classId: string; propertyId: string }) =>
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
    mutationFn: ({ classId, propertyId }: { classId: string; propertyId: string }) =>
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
    mutationFn: ({ classId, propertyIds }: { classId: string; propertyIds: string[] }) =>
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
      classId: string;
      propertyId: string;
      data: {
        required?: boolean | null;
        hidden?: boolean;
        readonly?: boolean | null;
        hide_when_empty?: boolean | null;
        default_value?: unknown | null;
      };
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
    mutationFn: ({ classId, extendsClassId }: { classId: string; extendsClassId: string }) =>
      propertiesApi.addClassExtends(resolveClassId(classId), resolveClassId(extendsClassId)),
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

  return useMutation({
    mutationFn: ({ classId, extendsClassId }: { classId: string; extendsClassId: string }) =>
      propertiesApi.removeClassExtends(resolveClassId(classId), resolveClassId(extendsClassId)),
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
