/**
 * Class Properties Hooks
 */
import { useMemo } from 'react';
import { useQuery, useMutation, useQueries } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import { propertyKeys } from '@/hooks/queryKeys';
import { orderClassPropertyEdges } from '../utils/classPropertyEdges';
import {
  useClassPropertiesAdapter,
  useNodeClassPropertyEdgesAdapter,
} from '@/core/adapters/useClassPropertiesAdapter';

/**
 * Legacy class-properties query. Imported by the SQLite adapter.
 */
export function useClassPropertiesLegacy(classId: string | null, includeInherited: boolean = false) {
  return useQuery({
    queryKey: includeInherited
      ? propertyKeys.forClassInherited(classId ?? '')
      : propertyKeys.forClass(classId ?? ''),
    queryFn: () => propertiesApi.getClassProperties(classId!, includeInherited),
    enabled: !!classId,
  });
}

export function useClassProperties(classId: string | null, includeInherited: boolean = false) {
  return useClassPropertiesAdapter(classId, includeInherited);
}

/**
 * Legacy node class-property edges query. Imported by the SQLite adapter.
 */
export function useNodeClassPropertyEdgesLegacy(classUuids: string[]) {
  const results = useQueries({
    queries: classUuids.map((classId) => ({
      queryKey: propertyKeys.forClassInherited(classId),
      queryFn: () => propertiesApi.getClassProperties(classId, true),
      enabled: !!classId,
    })),
  });

  return useMemo(
    () => orderClassPropertyEdges(classUuids, results.map((r) => r.data)),
    [classUuids, results],
  );
}

export function useNodeClassPropertyEdges(classUuids: string[]) {
  return useNodeClassPropertyEdgesAdapter(classUuids);
}

export function useClassExtends(classId: string | null) {
  return useQuery({
    queryKey: propertyKeys.classExtends(classId ?? ''),
    queryFn: () => propertiesApi.getClassExtends(classId!),
    enabled: !!classId,
  });
}

export function useInheritedProperties(classId: string | null) {
  return useQuery({
    queryKey: propertyKeys.inheritedProperties(classId ?? ''),
    queryFn: () => propertiesApi.getInheritedProperties(classId!),
    enabled: !!classId,
  });
}

export function useExtendedByClasses(classId: string | null) {
  return useQuery({
    queryKey: propertyKeys.extendedByClasses(classId ?? ''),
    queryFn: () => propertiesApi.getExtendedByClasses(classId!),
    enabled: !!classId,
  });
}

export function useValidateClassExtends() {
  return useMutation({
    mutationFn: ({ classId, extendsIds }: { classId: string; extendsIds: string[] }) =>
      propertiesApi.validateClassExtends(classId, extendsIds),
  });
}
