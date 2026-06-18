import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { Property, Node } from '@/types/api';
import { useSetNodeProperty } from '../hooks';
import { nodeKeys } from '@/features/content';
import { useNavigationStore } from '@/stores';
import * as nodesApi from '@/api/nodes';
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

  // Parse node IDs from value
  const isMultiValue = property.multi || Array.isArray(value);
  const nodeIds: number[] = isMultiValue && Array.isArray(value)
    ? value.filter((v): v is number => typeof v === 'number')
    : typeof value === 'number'
      ? [value]
      : [];

  // Fetch all nodes in parallel
  const nodeQueries = useQueries({
    queries: nodeIds.map((nodeId) => ({
      queryKey: nodeKeys.detail(nodeId, { include_children: false }),
      queryFn: () => nodesApi.getNode(nodeId, { include_children: false }),
      staleTime: 5 * 60 * 1000,
    })),
  });

  // Extract resolved nodes
  const resolvedNodes = useMemo(() => {
    return nodeQueries
      .map(query => query.data)
      .filter((n): n is Node => n !== undefined);
  }, [nodeQueries]);

  const isLoading = nodeQueries.some(q => q.isLoading);

  // Asset properties: render as images
  if (isAssetProperty && nodeIds.length > 0) {
    if (isLoading) {
      return (
        <div className="property-cell property-cell--loading">
          <Spinner size="sm" />
        </div>
      );
    }

    return (
      <div className="property-cell property-cell--image">
        {nodeIds.map((nodeId) => (
          <AssetImage
            key={nodeId}
            assetNodeId={nodeId}
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
  if (isLoading && nodeIds.length > 0) {
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
        classFilters={property.class_filters}
        emptyText="Add"
        searchPlaceholder="Search..."
        onNodeClick={(selectedNode) => {
          openNode(selectedNode.id);
        }}
        onAdd={editable ? (selectedNode) => {
          const currentValue = isMultiValue && Array.isArray(value) ? value : (value ? [value] : []);
          const newValue = property.multi
            ? [...currentValue, selectedNode.id]
            : selectedNode.id;
          setPropertyMutation.mutate({
            nodeId: parentNode.id,
            propertyId: property.id,
            value: newValue,
          });
        } : undefined}
        onRemove={editable ? (selectedNode) => {
          if (property.multi && Array.isArray(value)) {
            setPropertyMutation.mutate({
              nodeId: parentNode.id,
              propertyId: property.id,
              value: value.filter(id => id !== selectedNode.id),
            });
          } else {
            // Single value: remove means set to null
            setPropertyMutation.mutate({
              nodeId: parentNode.id,
              propertyId: property.id,
              value: null,
            });
          }
        } : undefined}
        readOnly={!editable}
      />
    </div>
  );
}
