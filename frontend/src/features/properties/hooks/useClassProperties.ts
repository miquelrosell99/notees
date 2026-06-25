/**
 * Class Properties Hooks
 */
import { useQuery, useMutation } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import { propertyKeys } from '@/hooks/queryKeys';

export function useClassProperties(classId: string | number | null, includeInherited: boolean = false) {
  return useQuery({
    queryKey: includeInherited
      ? propertyKeys.forClassInherited(classId ?? '')
      : propertyKeys.forClass(classId ?? ''),
    queryFn: () => propertiesApi.getClassProperties(classId!, includeInherited),
    enabled: !!classId,
  });
}

export function useClassExtends(classId: string | number | null) {
  return useQuery({
    queryKey: propertyKeys.classExtends(classId ?? ''),
    queryFn: () => propertiesApi.getClassExtends(classId!),
    enabled: !!classId,
  });
}

export function useInheritedProperties(classId: string | number | null) {
  return useQuery({
    queryKey: propertyKeys.inheritedProperties(classId ?? ''),
    queryFn: () => propertiesApi.getInheritedProperties(classId!),
    enabled: !!classId,
  });
}

export function useExtendedByClasses(classId: string | number | null) {
  return useQuery({
    queryKey: propertyKeys.extendedByClasses(classId ?? ''),
    queryFn: () => propertiesApi.getExtendedByClasses(classId!),
    enabled: !!classId,
  });
}

export function useValidateClassExtends() {
  return useMutation({
    mutationFn: ({ classId, extendsIds }: { classId: string | number; extendsIds: (string | number)[] }) =>
      propertiesApi.validateClassExtends(classId, extendsIds),
  });
}
