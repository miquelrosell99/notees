/**
 * Class Properties Hooks
 */
import { useQuery, useMutation } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import { propertyKeys } from '@/hooks/queryKeys';
import { resolveNodeUuid } from '@/utils/resolveNodeUuid';

function resolveClassId(classId: string | number): string {
  return typeof classId === 'string' ? classId : resolveNodeUuid(classId);
}

export function useClassProperties(classId: string | number | null, includeInherited: boolean = false) {
  return useQuery({
    queryKey: includeInherited
      ? propertyKeys.forClassInherited(classId ?? '')
      : propertyKeys.forClass(classId ?? ''),
    queryFn: () => propertiesApi.getClassProperties(resolveClassId(classId!), includeInherited),
    enabled: !!classId,
  });
}

export function useClassExtends(classId: string | number | null) {
  return useQuery({
    queryKey: propertyKeys.classExtends(classId ?? ''),
    queryFn: () => propertiesApi.getClassExtends(resolveClassId(classId!)),
    enabled: !!classId,
  });
}

export function useInheritedProperties(classId: string | number | null) {
  return useQuery({
    queryKey: propertyKeys.inheritedProperties(classId ?? ''),
    queryFn: () => propertiesApi.getInheritedProperties(resolveClassId(classId!)),
    enabled: !!classId,
  });
}

export function useExtendedByClasses(classId: string | number | null) {
  return useQuery({
    queryKey: propertyKeys.extendedByClasses(classId ?? ''),
    queryFn: () => propertiesApi.getExtendedByClasses(resolveClassId(classId!)),
    enabled: !!classId,
  });
}

export function useValidateClassExtends() {
  return useMutation({
    mutationFn: ({ classId, extendsIds }: { classId: string | number; extendsIds: (string | number)[] }) =>
      propertiesApi.validateClassExtends(resolveClassId(classId), extendsIds.map(resolveNodeUuid)),
  });
}
