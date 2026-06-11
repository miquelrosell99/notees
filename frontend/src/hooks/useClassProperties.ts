/**
 * Class Properties Hooks
 */
import { useQuery, useMutation } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import { propertyKeys } from './queryKeys';

export function useClassProperties(classId: number | null, includeInherited: boolean = false) {
  return useQuery({
    queryKey: includeInherited
      ? propertyKeys.forClassInherited(classId ?? 0)
      : propertyKeys.forClass(classId ?? 0),
    queryFn: () => propertiesApi.getClassProperties(classId!, includeInherited),
    enabled: !!classId,
  });
}

export function useClassExtends(classId: number | null) {
  return useQuery({
    queryKey: propertyKeys.classExtends(classId ?? 0),
    queryFn: () => propertiesApi.getClassExtends(classId!),
    enabled: !!classId,
  });
}

export function useInheritedProperties(classId: number | null) {
  return useQuery({
    queryKey: propertyKeys.inheritedProperties(classId ?? 0),
    queryFn: () => propertiesApi.getInheritedProperties(classId!),
    enabled: !!classId,
  });
}

export function useExtendedByClasses(classId: number | null) {
  return useQuery({
    queryKey: propertyKeys.extendedByClasses(classId ?? 0),
    queryFn: () => propertiesApi.getExtendedByClasses(classId!),
    enabled: !!classId,
  });
}

export function useValidateClassExtends() {
  return useMutation({
    mutationFn: ({ classId, extendsIds }: { classId: number; extendsIds: number[] }) =>
      propertiesApi.validateClassExtends(classId, extendsIds),
  });
}
