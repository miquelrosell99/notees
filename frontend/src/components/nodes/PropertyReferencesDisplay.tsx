/**
 * PropertyReferencesDisplay Component
 * 
 * Fetches and displays properties for a node in linked references.
 * Shows only the properties that reference a specific target node.
 */
import { useMemo } from 'react';
import type { Node, Property } from '@/types';
import { useNode } from '@/hooks/useNodes';
import { useProperties } from '@/hooks/useProperties';
import { NodeProperty } from './PropertyReferenceDisplay';
import './PropertyReferencesDisplay.css';

export interface PropertyReferencesDisplayProps {
  /** The node with properties to display */
  node: Node;
  /** Property ID to filter (show only this property) */
  propertyId?: number;
  /** Property name to filter (show only this property) */
  propertyName?: string;
  /** Target node ID that was referenced */
  targetNodeId: number;
  /** Callback when navigating to a node */
  onNavigateToNode?: (nodeId: number) => void;
  /** Callback when opening in sidebar */
  onOpenInSidebar?: (nodeId: number) => void;
}

export function PropertyReferencesDisplay({
  node,
  propertyId,
  propertyName,
  targetNodeId,
  onNavigateToNode,
  onOpenInSidebar,
}: PropertyReferencesDisplayProps) {
  // Use sourceNodeId from metadata if available (when displaying page in list view),
  // otherwise use the node's own ID
  const actualNodeId = node._linkedRefMetadata?.sourceNodeId ?? node.id;
  
  // Fetch node with properties
  const { data: nodeWithProps, isLoading: nodeLoading } = useNode(actualNodeId, { include_properties: true });
  
  // Fetch all property definitions
  const { data: allProperties = [], isLoading: propsLoading } = useProperties();

  // Filter to only show properties that:
  // 1. Match the property ID/name (if provided)
  // 2. Have values that reference the target node
  const relevantProperties = useMemo(() => {
    if (!nodeWithProps?.properties || !allProperties.length) return [];
    
    const results: Array<{ property: Property; value: unknown }> = [];
    
    // Iterate over the node's properties (Record<string, unknown> where keys are property IDs as strings)
    for (const [propIdStr, value] of Object.entries(nodeWithProps.properties)) {
      const propId = parseInt(propIdStr, 10);
      
      // Find the property definition
      const property = allProperties.find((p: Property) => p.id === propId);
      if (!property) continue;
      
      // Filter by property ID or name if provided
      if (propertyId && property.id !== propertyId) continue;
      if (propertyName && property.name !== propertyName) continue;
      
      // Only show if this property has a value that references the target node
      if (property.type === 'node') {
        // Check if any value references the target node
        const values = Array.isArray(value) ? value : [value];
        const hasTargetRef = values.some((val: unknown) => {
          // Value can be a node ID (number) or node object
          if (typeof val === 'number') return val === targetNodeId;
          if (typeof val === 'object' && val !== null && 'id' in val) {
            return (val as Node).id === targetNodeId;
          }
          return false;
        });
        
        if (hasTargetRef) {
          results.push({ property, value });
        }
      }
    }
    
    return results;
  }, [nodeWithProps?.properties, allProperties, propertyId, propertyName, targetNodeId]);

  if (nodeLoading || propsLoading) {
    return (
      <div className="property-references-display property-references-display--loading">
        Loading properties...
      </div>
    );
  }

  if (relevantProperties.length === 0) {
    return null;
  }

  return (
    <div className="property-references-display">
      <div className="property-references-display__header">Properties</div>
      <div className="property-references-display__list">
        {relevantProperties.map(({ property, value }) => (
          <NodeProperty
            key={property.id}
            property={property}
            value={value}
            readOnly={true}
            onNavigateToNode={onNavigateToNode}
            onOpenInSidebar={onOpenInSidebar}
            showBullet={true}
            compact={false}
          />
        ))}
      </div>
    </div>
  );
}

export default PropertyReferencesDisplay;
