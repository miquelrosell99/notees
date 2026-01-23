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
 * Hook to fetch properties for a type/class
 */
export function useTypeProperties(typeId: number | null, includeInherited: boolean = false) {
  return useQuery({
    queryKey: includeInherited 
      ? propertyKeys.forTypeInherited(typeId ?? 0)
      : propertyKeys.forType(typeId ?? 0),
    queryFn: () => propertiesApi.getTypeProperties(typeId!, includeInherited),
    enabled: !!typeId,
  });
}

/**
 * Hook to fetch types that a type extends (parents)
 */
export function useTypeExtends(typeId: number | null) {
  return useQuery({
    queryKey: propertyKeys.typeExtends(typeId ?? 0),
    queryFn: () => propertiesApi.getTypeExtends(typeId!),
    enabled: !!typeId,
  });
}

/**
 * Hook to add property to type/class
 */
export function useAddPropertyToType() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ typeId, propertyId }: { typeId: number; propertyId: number }) => 
      propertiesApi.addTypeProperty(typeId, propertyId),
    onSuccess: (_, { typeId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.forType(typeId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forTypeInherited(typeId) });
    },
  });
}

/**
 * Hook to remove property from type/class
 */
export function useRemovePropertyFromType() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ typeId, propertyId }: { typeId: number; propertyId: number }) => 
      propertiesApi.removeTypeProperty(typeId, propertyId),
    onSuccess: (_, { typeId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.forType(typeId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forTypeInherited(typeId) });
    },
  });
}

/**
 * Hook to add type extension (inheritance)
 */
export function useAddTypeExtends() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ typeId, extendsTypeId }: { typeId: number; extendsTypeId: number }) => 
      propertiesApi.addTypeExtends(typeId, extendsTypeId),
    onSuccess: (_, { typeId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.typeExtends(typeId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forTypeInherited(typeId) });
    },
  });
}

/**
 * Hook to remove type extension (inheritance)
 */
export function useRemoveTypeExtends() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ typeId, extendsTypeId }: { typeId: number; extendsTypeId: number }) => 
      propertiesApi.removeTypeExtends(typeId, extendsTypeId),
    onSuccess: (_, { typeId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.typeExtends(typeId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forTypeInherited(typeId) });
    },
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
        is_type: item.is_type,
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
