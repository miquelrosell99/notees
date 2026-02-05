/**
 * NodePropertiesSection Component
 * 
 * Reusable component that renders a list of properties as NodeProperty elements.
 * Used by both PropertiesSection (with section wrapper) and Block (direct rendering).
 */
import { useMemo } from 'react';
import { useNode, useProperties, useClassProperties } from '@/hooks';
import type { Property, ClassProperty } from '@/types/api';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { NodeProperty } from './PropertyReferenceDisplay';

export interface NodePropertiesSectionProps {
  /** Node ID to fetch properties for */
  nodeId: number;
  /** Filter to only show specific property IDs */
  filterPropertyIds?: number[];
  /** Whether properties are read-only */
  readOnly?: boolean;
  /** Callback when navigating to a node */
  onNavigateToNode?: (nodeId: number) => void;
  /** Callback when opening in sidebar */
  onOpenInSidebar?: (nodeId: number) => void;
  /** Callback when property name is clicked */
  onPropertyNameClick?: (property: Property, event: React.MouseEvent) => void;
  /** Show decorative bullets (default: true) */
  showBullets?: boolean;
  /** Compact display mode */
  compact?: boolean;
}

export function NodePropertiesSection({
  nodeId,
  filterPropertyIds,
  readOnly = false,
  onNavigateToNode,
  onOpenInSidebar,
  onPropertyNameClick,
  showBullets = true,
  compact = false,
}: NodePropertiesSectionProps) {
  // Fetch node with properties
  const { data: node, isLoading: nodeLoading } = useNode(nodeId, { include_properties: true });
  
  // Fetch all property definitions
  const { data: allProperties } = useProperties();
  
  // Get class properties for all classes the node has (with inheritance)
  const firstClassId = node?.classes?.[0] ?? null;
  const { data: classProperties1 } = useClassProperties(firstClassId, true);
  const secondClassId = node?.classes?.[1] ?? null;
  const { data: classProperties2 } = useClassProperties(secondClassId, true);
  const thirdClassId = node?.classes?.[2] ?? null;
  const { data: classProperties3 } = useClassProperties(thirdClassId, true);

  // Combine properties from classes and node properties
  const properties = useMemo(() => {
    if (!allProperties) return [];
    
    const entries: Array<{ property: Property; value: unknown; source?: string; hidden?: boolean }> = [];
    const addedPropertyIds = new Set<number>();
    
    // First, add properties from classes (with inheritance)
    const allClassProperties: ClassProperty[] = [
      ...(classProperties1 ?? []),
      ...(classProperties2 ?? []),
      ...(classProperties3 ?? []),
    ];
    
    for (const classProp of allClassProperties) {
      if (addedPropertyIds.has(classProp.property_id)) continue;
      addedPropertyIds.add(classProp.property_id);
      
      // Find the full property definition
      const prop = allProperties.find(p => p.id === classProp.property_id);
      if (!prop) continue;
      
      // Skip system properties (cover, banner)
      if (prop.uuid === SYSTEM_PROPERTY_UUIDS.cover || prop.uuid === SYSTEM_PROPERTY_UUIDS.banner) continue;
      
      // Get value from node properties if it exists
      const value = node?.properties && String(prop.id) in (node.properties as Record<string, unknown>)
        ? (node.properties as Record<string, unknown>)[String(prop.id)]
        : classProp.default_value ?? null;
      
      entries.push({
        property: prop,
        value,
        source: classProp.class_node_name || `Class #${classProp.class_node_id}`,
        hidden: classProp.hidden ?? false,
      });
    }
    
    // Then add any additional properties that have values on this node
    if (node?.properties) {
      for (const prop of allProperties) {
        if (addedPropertyIds.has(prop.id)) continue;
        
        // Skip system properties
        if (prop.uuid === SYSTEM_PROPERTY_UUIDS.cover || prop.uuid === SYSTEM_PROPERTY_UUIDS.banner) continue;
        
        const hasProperty = String(prop.id) in (node.properties as Record<string, unknown>);
        if (hasProperty) {
          entries.push({
            property: prop,
            value: (node.properties as Record<string, unknown>)[String(prop.id)],
            hidden: false,
          });
          addedPropertyIds.add(prop.id);
        }
      }
    }
    
    return entries;
  }, [node, allProperties, classProperties1, classProperties2, classProperties3]);

  // Apply filter if filterPropertyIds is provided
  const filteredProperties = useMemo(() => {
    if (!filterPropertyIds || filterPropertyIds.length === 0) return properties;
    return properties.filter(({ property }) => filterPropertyIds.includes(property.id));
  }, [properties, filterPropertyIds]);

  // Only show visible properties (not hidden)
  const visibleProperties = useMemo(
    () => filteredProperties.filter(p => !p.hidden),
    [filteredProperties]
  );

  if (nodeLoading || visibleProperties.length === 0) {
    return null;
  }

  return (
    <>
      {visibleProperties.map(({ property, value, source }) => (
        <NodeProperty
          key={property.id}
          property={property}
          value={value}
          source={source}
          readOnly={readOnly}
          onNavigateToNode={onNavigateToNode}
          onOpenInSidebar={onOpenInSidebar}
          onPropertyNameClick={onPropertyNameClick}
          showBullet={showBullets}
          compact={compact}
        />
      ))}
    </>
  );
}
