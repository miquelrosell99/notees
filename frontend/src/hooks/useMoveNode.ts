import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { Node } from '@/types/api';
import { nodeKeys } from './queryKeys';

/**
 * Hook to move a node
 */
export function useMoveNode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, parentId, position }: { id: number; parentId: number | null; position?: number }) =>
      nodesApi.moveNode(id, parentId, position),
    onMutate: async ({ id, parentId, position }) => {
      // Cancel any outgoing refetches to not overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: nodeKeys.details() });
      await queryClient.cancelQueries({ queryKey: nodeKeys.pageContents() });
      await queryClient.cancelQueries({ queryKey: nodeKeys.uuids() });

      // Find the node being moved from any cache
      let movedNode: Node | null = null;

      // Helper to search a node tree for the node with the given id
      const findInChildren = (node: Node): Node | null => {
        if (node.children) {
          for (const child of node.children) {
            if (child.id === id) return child;
            const found = findInChildren(child);
            if (found) return found;
          }
        }
        return null;
      };

      // Search through all cached detail queries to find the node
      const detailQueries = queryClient.getQueriesData<Node>({ queryKey: nodeKeys.details() });
      for (const [, data] of detailQueries) {
        if (!data) continue;
        if (data.id === id) { movedNode = data; break; }
        const found = findInChildren(data);
        if (found) { movedNode = found; break; }
      }

      // Also search byUuid queries (e.g. blocks under the Scratchpad page)
      if (!movedNode) {
        const byUuidQueries = queryClient.getQueriesData<Node>({ queryKey: nodeKeys.uuids() });
        for (const [, data] of byUuidQueries) {
          if (!data) continue;
          if (data.id === id) { movedNode = data; break; }
          const found = findInChildren(data);
          if (found) { movedNode = found; break; }
        }
      }

      if (!movedNode) return; // Can't do optimistic update without the node data

      // Helper to remove a node from children array
      const removeFromChildren = (children: Node[] | null | undefined): Node[] => {
        if (!children) return [];
        return children.filter(c => c.id !== id).map(c => ({
          ...c,
          children: removeFromChildren(c.children),
        }));
      };

      // Helper to insert node at the correct position in a children array
      const insertAtPosition = (children: Node[], nodeToInsert: Node, pos: number): Node[] => {
        const newChildren = [...children];
        // Update the moved node with new parent and sequence
        const updatedNode = {
          ...nodeToInsert,
          parent_id: parentId,
          sequence: pos
        };
        // Insert at the right position
        newChildren.splice(pos, 0, updatedNode);
        // Update sequences for nodes after the insertion point
        return newChildren.map((child, idx) => ({
          ...child,
          sequence: idx,
        }));
      };

      // Helper to recursively insert the moved node at the new parent location
      const insertAtParent = (node: Node, nodeToInsert: Node, targetParentId: number | null, pos: number): Node => {
        // If this node is the target parent, insert the moved node into its children
        if (node.id === targetParentId) {
          const currentChildren = node.children || [];
          return {
            ...node,
            children: insertAtPosition(currentChildren, nodeToInsert, pos),
          };
        }

        // Otherwise, recursively check children
        if (node.children && node.children.length > 0) {
          return {
            ...node,
            children: node.children.map(child => insertAtParent(child, nodeToInsert, targetParentId, pos)),
          };
        }

        return node;
      };

      // Update all detail queries
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.details() },
        (oldNode) => {
          if (!oldNode) return oldNode;

          // First remove the moved node from anywhere in the tree
          let updated: Node = {
            ...oldNode,
            children: oldNode.children ? removeFromChildren(oldNode.children) : [],
          };

          // Then insert at the new parent location (recursively finds the parent)
          if (movedNode && parentId !== null) {
            updated = insertAtParent(updated, movedNode, parentId, position ?? 0);
          }

          return updated;
        }
      );

      // Also update page-content queries
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.pageContents() },
        (oldNode) => {
          if (!oldNode) return oldNode;

          // First remove the moved node from anywhere in the tree
          let updated: Node = {
            ...oldNode,
            children: oldNode.children ? removeFromChildren(oldNode.children) : [],
          };

          // Then insert at the new parent location (recursively finds the parent)
          if (movedNode && parentId !== null) {
            updated = insertAtParent(updated, movedNode, parentId, position ?? 0);
          }

          return updated;
        }
      );

      // Also update byUuid queries (e.g. Scratchpad uses useNodeByUuid with include_children)
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.uuids() },
        (oldNode) => {
          if (!oldNode) return oldNode;

          // First remove the moved node from anywhere in the tree
          let updated: Node = {
            ...oldNode,
            children: oldNode.children ? removeFromChildren(oldNode.children) : [],
          };

          // Then insert at the new parent location (recursively finds the parent)
          if (movedNode && parentId !== null) {
            updated = insertAtParent(updated, movedNode, parentId, position ?? 0);
          }

          return updated;
        }
      );
    },
    onSuccess: (_movedNode, _variables) => {
      // The optimistic update in onMutate already handled the tree restructuring.
      // We don't refetch immediately to avoid UI flash.
      // Just mark queries as stale so they'll refetch on next navigation/focus.
      queryClient.invalidateQueries({
        queryKey: nodeKeys.details(),
        refetchType: 'none', // Mark stale but don't refetch
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.pageContents(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.uuids(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.lists(),
        refetchType: 'none',
      });
      // Moving a node changes its page context, which affects linked references
      // and property backlinks for any pages the block links to.
      queryClient.invalidateQueries({
        queryKey: ['nodes', 'linked-refs'],
      });
      queryClient.invalidateQueries({
        queryKey: ['nodes', 'property-backlinks'],
      });

      // Invalidate pages, search, and breadcrumbs so command palette breadcrumbs update
      queryClient.invalidateQueries({
        queryKey: nodeKeys.pages(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: [...nodeKeys.all, 'search'],
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: [...nodeKeys.all, 'breadcrumbs'],
        refetchType: 'none',
      });
    },
  });
}
