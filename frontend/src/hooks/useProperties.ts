/**
 * Property Hooks
 * 
 * React Query hooks for property queries and mutations.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import * as nodesApi from '@/api/nodes';
import type { PropertyCreate, Node } from '@/types/api';
import { nodeKeys, propertyKeys } from './queryKeys';

// ==================== Property Queries ====================

/**
 * Hook to fetch all properties
 */
export function useProperties() {
  return useQuery({
    queryKey: propertyKeys.list(),
    queryFn: () => propertiesApi.listProperties(),
  });
}

/**
 * Hook to fetch a single property
 */
export function useProperty(id: number | null) {
  return useQuery({
    queryKey: propertyKeys.detail(id ?? 0),
    queryFn: () => propertiesApi.getProperty(id!),
    enabled: !!id,
  });
}

// ==================== Property Mutations ====================

/**
 * Hook to create a property
 */
export function useCreateProperty() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: PropertyCreate) => 
      propertiesApi.createProperty(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.lists() });
    },
  });
}

/**
 * Hook to update a property
 */
export function useUpdateProperty() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: { name?: string; icon?: string } }) => 
      propertiesApi.updateProperty(id, data),
    onSuccess: (updated) => {
      queryClient.setQueryData(propertyKeys.detail(updated.id), updated);
      queryClient.invalidateQueries({ queryKey: propertyKeys.lists() });
    },
  });
}

// ==================== Type Properties (for Types/Classes) ====================

/**
 * Hook to fetch properties for a class
 */
export function useClassProperties(classId: number | null, includeInherited: boolean = false) {
  return useQuery({
    queryKey: includeInherited 
      ? propertyKeys.forClassInherited(classId ?? 0)
      : propertyKeys.forClass(classId ?? 0),
    queryFn: () => propertiesApi.getClassProperties(classId!, includeInherited),
    enabled: !!classId,
  });
}

/**
 * Hook to fetch classes that a class extends (parents)
 */
export function useClassExtends(classId: number | null) {
  return useQuery({
    queryKey: propertyKeys.classExtends(classId ?? 0),
    queryFn: () => propertiesApi.getClassExtends(classId!),
    enabled: !!classId,
  });
}

/**
 * Hook to add property to class
 */
export function useAddPropertyToClass() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ classId, propertyId }: { classId: number; propertyId: number }) => 
      propertiesApi.addClassProperty(classId, propertyId),
    onSuccess: (_, { classId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClass(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
    },
  });
}

/**
 * Hook to remove property from class
 */
export function useRemovePropertyFromClass() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ classId, propertyId }: { classId: number; propertyId: number }) => 
      propertiesApi.removeClassProperty(classId, propertyId),
    onSuccess: (_, { classId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClass(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
    },
  });
}

/**
 * Hook to add class extension (inheritance)
 */
export function useAddClassExtends() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ classId, extendsClassId }: { classId: number; extendsClassId: number }) => 
      propertiesApi.addClassExtends(classId, extendsClassId),
    onSuccess: (_, { classId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.classExtends(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      // Invalidate nodes list so resolved extends details update in UI
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
}

/**
 * Hook to remove class extension (inheritance)
 */
export function useRemoveClassExtends() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ classId, extendsClassId }: { classId: number; extendsClassId: number }) => 
      propertiesApi.removeClassExtends(classId, extendsClassId),
    onSuccess: (_, { classId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.classExtends(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      // Invalidate nodes list so resolved extends details update in UI
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
}

/**
 * Hook to get inherited properties for a class
 */
export function useInheritedProperties(classId: number | null) {
  return useQuery({
    queryKey: propertyKeys.inheritedProperties(classId ?? 0),
    queryFn: () => propertiesApi.getInheritedProperties(classId!),
    enabled: !!classId,
  });
}

/**
 * Hook to get classes that extend this class (reverse lookup)
 */
export function useExtendedByClasses(classId: number | null) {
  return useQuery({
    queryKey: propertyKeys.extendedByClasses(classId ?? 0),
    queryFn: () => propertiesApi.getExtendedByClasses(classId!),
    enabled: !!classId,
  });
}

/**
 * Hook to validate class extends (check for circular inheritance)
 */
export function useValidateClassExtends() {
  return useMutation({
    mutationFn: ({ classId, extendsIds }: { classId: number; extendsIds: number[] }) => 
      propertiesApi.validateClassExtends(classId, extendsIds),
  });
}

/**
 * Hook to set node property value
 * When value is null, removes the property instead of setting it to null
 */
export function useSetNodeProperty() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ nodeId, propertyId, value }: { nodeId: number; propertyId: number; value: unknown }) => {
      // If value is null, remove the property instead of setting it
      if (value === null) {
        return nodesApi.removeProperty(nodeId, propertyId);
      }
      return nodesApi.setProperty(nodeId, propertyId, value);
    },
    onSuccess: (_, { nodeId }) => {
      // Invalidate both detail and page content queries since properties
      // are used in page headers (cover, banner) and node details
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });
    },
    onError: (error, variables) => {
      console.error(`Failed to set property ${variables.propertyId} on node ${variables.nodeId}:`, error);
    },
  });
}

/**
 * Hook to get nodes that have a specific property using the property ID
 */
export function useNodesWithProperty(propertyId: number | null) {
  return useQuery({
    queryKey: ['property-nodes', propertyId],
    queryFn: async () => {
      if (!propertyId) return [];
      // Use the dedicated API endpoint that queries by property ID
      const { getNodesWithProperty } = await import('@/api/properties');
      const response = await getNodesWithProperty(propertyId);
      
      // Convert API response to Node format
      return response.nodes.map(item => ({
        id: item.node_id,
        uuid: item.node_uuid,
        name: item.node_name,
        icon: item.node_icon,
        color: item.node_color,
        parent_id: item.parent_id,
        page_id: item.page_id,
        is_page: item.is_page,
        is_class: item.is_class,
        sequence: 0,
        collapsed: false,
        active: true,
        create_date: item.create_date,
        write_date: item.write_date,
      } as Node));
    },
    enabled: !!propertyId,
    staleTime: 30000,
  });
}
