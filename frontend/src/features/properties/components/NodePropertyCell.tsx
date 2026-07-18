import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { Property, Node } from '@/types/api';
import { useSetNodeProperty } from '../hooks';
import { nodeKeys } from '@/hooks/queryKeys';
import { useNavigationStore } from '@/stores';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { getNodeByUuid } from '@/core/query/nodeByUuid';
import { NodeSelector } from '@/features/content';
import { AssetImage } from '@/features/content';
import { Spinner } from '@/components/ui/Spinner';
import './PropertyCell.css';

interface NodePropertyCellProps {
  property: Property;
  parentNode: Node;
  value: unknown;
  editable: boolean;
  isAssetProperty: boolean;
}

/**
 * NodePropertyCell - Handles all node-type properties (empty/single/multi, asset/regular)
 * Uses NodeSelector for regular nodes, AssetImage for assets
 */
export function NodePropertyCell({
  property,
  parentNode,
  value,
  editable,
  isAssetProperty,
}: NodePropertyCellProps) {
  const setPropertyMutation = useSetNodeProperty();
  const openNode = useNavigationStore(state => state.openNode);
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading: storeLoading } = useWorkspaceStore(workspaceUuid ?? '');

  // Parse node UUIDs from value
  const isMultiValue = property.multi || Array.isArray(value);
  const nodeUuids: string[] = isMultiValue && Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string'
      ? [value]
      : [];

  // Resolve nodes from the local-first core store
  const nodeQueries = useQueries({
    queries: nodeUuids.map((nodeUuid) => ({
      queryKey: nodeKeys.byUuid(nodeUuid),
      queryFn: () => {
        if (!store) throw new Error('Workspace store is not ready');
        const node = getNodeByUuid(store, nodeUuid);
        if (!node) throw new Error(`Node ${nodeUuid} not found`);
        return node;
      },
      enabled: !!store,
      staleTime: 5 * 60 * 1000,
    })),
  });

  // Extract resolved nodes
  const resolvedNodes = useMemo(() => {
    return nodeQueries
      .map(query => query.data)
      .filter((n): n is Node => n !== undefined);
  }, [nodeQueries]);

  const isLoading = storeLoading || nodeQueries.some(q => q.isLoading);

  // Asset properties: render as images
  if (isAssetProperty && nodeUuids.length > 0) {
    if (isLoading) {
      return (
        <div className="property-cell property-cell--loading">
          <Spinner size="sm" />
        </div>
      );
    }

    return (
      <div className="property-cell property-cell--image">
        {nodeUuids.map((nodeUuid) => (
          <AssetImage
            key={nodeUuid}
            assetNodeId={nodeUuid}
            showCard={false}
            clickable={true}
            showActions={false}
            className="property-cell__asset"
            imageClassName="property-cell__asset-img"
          />
        ))}
      </div>
    );
  }

  // Regular node properties: use NodeSelector
  if (isLoading && nodeUuids.length > 0) {
    return (
      <div className="property-cell property-cell--loading">
        <Spinner size="sm" />
      </div>
    );
  }

  return (
    <div className="property-cell property-cell--node-multi">
      <NodeSelector
        nodes={resolvedNodes}
        searchMode="pages"
        classFilters={property.class_filter_uuids ?? []}
        emptyText="Add"
        searchPlaceholder="Search..."
        onNodeClick={(selectedNode) => {
          openNode(selectedNode.uuid);
        }}
        onAdd={editable ? (selectedNode) => {
          const currentValue = isMultiValue && Array.isArray(value) ? value : (value ? [value] : []);
          const newValue = property.multi
            ? [...currentValue, selectedNode.uuid]
            : selectedNode.uuid;
          setPropertyMutation.mutate({
            nodeUuid: parentNode.uuid,
            propertyId: property.uuid,
            value: newValue,
          });
        } : undefined}
        onRemove={editable ? (selectedNode) => {
          if (property.multi && Array.isArray(value)) {
            setPropertyMutation.mutate({
              nodeUuid: parentNode.uuid,
              propertyId: property.uuid,
              value: value.filter(id => id !== selectedNode.uuid),
            });
          } else {
            // Single value: remove means set to null
            setPropertyMutation.mutate({
              nodeUuid: parentNode.uuid,
              propertyId: property.uuid,
              value: null,
            });
          }
        } : undefined}
        readOnly={!editable}
      />
    </div>
  );
}
