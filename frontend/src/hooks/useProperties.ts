/**
 * Property Hooks
 * 
 * React Query hooks for property queries and mutations.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import * as nodesApi from '@/api/nodes';
import type { BatchPropertiesResult } from '@/api/nodes';
import type { PropertyCreate, Node } from '@/types/api';
import { nodeKeys, propertyKeys } from './queryKeys';
import { nodeViewKeys } from './useNodeViews';

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

/**
 * Batch-fetch property values for multiple nodes in one request.
 * Returns { nodeId -> { propertyId -> value } }.
 * Only fires when nodeIds is non-empty; staleTime prevents re-fetching on every render.
 */
export function useBatchPropertyValues(nodeIds: number[]) {
  return useQuery<BatchPropertiesResult>({
    queryKey: nodeKeys.batchProperties(nodeIds),
    queryFn: () => nodesApi.batchGetPropertyValues(nodeIds),
    enabled: nodeIds.length > 0,
    staleTime: 30_000,
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
    mutationFn: ({ id, data }: { id: number; data: { name?: string; icon?: string; multi?: boolean; icon_visibility?: string } }) => 
      propertiesApi.updateProperty(id, data),
    onSuccess: (updated) => {
      queryClient.setQueryData(propertyKeys.detail(updated.id), updated);
      queryClient.invalidateQueries({ queryKey: propertyKeys.lists() });
    },
  });
}

/**
 * Hook to delete a property
 */
export function useDeleteProperty() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (id: number) => 
      propertiesApi.deleteProperty(id),
    onSuccess: (_, id) => {
      // Remove from cache
      queryClient.removeQueries({ queryKey: propertyKeys.detail(id) });
      // Invalidate lists to refresh all property lists
      queryClient.invalidateQueries({ queryKey: propertyKeys.lists() });
      // Invalidate all nodes since they might have this property
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
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
 * Hook to reorder class properties
 */
export function useReorderClassProperties() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ classId, propertyIds }: { classId: number; propertyIds: number[] }) =>
      propertiesApi.reorderClassProperties(classId, propertyIds),
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
    onSuccess: (_, { classId, extendsClassId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.classExtends(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      // Invalidate "extended by" cache on the target class
      queryClient.invalidateQueries({ queryKey: propertyKeys.extendedByClasses(extendsClassId) });
      // Invalidate query-based views (e.g. "extended by" QuerySection)
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
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
    onSuccess: (_, { classId, extendsClassId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.classExtends(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      // Invalidate "extended by" cache on the target class
      queryClient.invalidateQueries({ queryKey: propertyKeys.extendedByClasses(extendsClassId) });
      // Invalidate query-based views (e.g. "extended by" QuerySection)
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
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
 * Hook to set node property value with optimistic batch-cache patching.
 * When value is null, removes the property instead of setting it to null.
 *
 * Mutation flow:
 *   onMutate  → cancel in-flight batch queries, snapshot, patch cache in O(1)
 *   onError   → rollback to snapshot
 *   onSettled → background-refetch non-batch caches (detail, pageContent)
 */
export function useSetNodeProperty() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ nodeId, propertyId, value }: { nodeId: number; propertyId: number; value: unknown }) => {
      if (value === null) {
        return nodesApi.removeProperty(nodeId, propertyId);
      }
      return nodesApi.setProperty(nodeId, propertyId, value);
    },

    onMutate: async ({ nodeId, propertyId, value }) => {
      // Cancel any in-flight batch-properties queries so they don't overwrite
      // our optimistic update when they land.
      const batchQueries = queryClient.getQueriesData<BatchPropertiesResult>({
        predicate: (q) =>
          Array.isArray(q.queryKey) && q.queryKey.includes('batch-properties'),
      });

      await queryClient.cancelQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) && q.queryKey.includes('batch-properties'),
      });

      // Snapshot every matching batch-properties cache entry for rollback.
      const snapshots: [readonly unknown[], BatchPropertiesResult | undefined][] = [];

      for (const [queryKey, data] of batchQueries) {
        snapshots.push([queryKey, data]);

        if (!data) continue;

        const nodeEntry = data[String(nodeId)];
        if (!nodeEntry) continue;

        // Shallow-clone only the root object and the affected node entry.
        // Every other nodeId entry keeps its reference — no unnecessary work.
        queryClient.setQueryData<BatchPropertiesResult>(queryKey, {
          ...data,
          [String(nodeId)]: value === null
            ? (() => {
                const { [String(propertyId)]: _, ...rest } = nodeEntry;
                return rest;
              })()
            : {
                ...nodeEntry,
                [String(propertyId)]: value,
              },
        });
      }

      return { snapshots };
    },

    onError: (error, { nodeId, propertyId }, context) => {
      console.error(`Failed to set property ${propertyId} on node ${nodeId}:`, error);

      // Rollback every batch-properties cache entry to its pre-mutation state.
      if (context?.snapshots) {
        for (const [queryKey, previous] of context.snapshots) {
          queryClient.setQueryData(queryKey, previous);
        }
      }
    },

    onSettled: (_, __, { nodeId }) => {
      // Background-refetch non-batch caches that also carry property data.
      // These are cheap and keep page headers / detail panels in sync.
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });

      // Silently re-validate batch caches in the background (inactive only)
      // so they converge with server truth without blocking the UI.
      queryClient.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) && q.queryKey.includes('batch-properties'),
        refetchType: 'none',
      });
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
        properties: item.properties,
        classes: item.class_ids,
      } as Node));
    },
    enabled: !!propertyId,
    staleTime: 30000,
  });
}
