/**
 * PropertyNodesView - Display nodes that have a specific property
 * 
 * Shows all nodes that have a particular property assigned,
 * using the same view types as linked references and tagged nodes.
 */
import { useState, useMemo, useCallback } from 'react';
import './PropertyNodesView.css';
import { useQuery } from '@tanstack/react-query';
import { getNodesWithProperty } from '@/api/properties';
import { useNodesStore } from '@/stores';
import type { Node, Property } from '@/types';
import { NodeIcon, BulletIcon } from './icons';
import { Button } from './core/Button';
import { NodeCollection } from './nodes/NodeCollection';
import { NodeGraphViewSimple } from './graph';

export interface PropertyNodesViewProps {
  /** The property to find nodes for */
  property: Property;
  /** Initial view mode */
  initialViewMode?: PropertyViewMode;
  /** Show view mode selector */
  showViewModeSelector?: boolean;
  /** Title override */
  title?: string;
  /** Maximum results to show (0 = no limit) */
  limit?: number;
  /** Callback when a node is clicked */
  onNodeClick?: (node: Node) => void;
}

export type PropertyViewMode = 'list' | 'cards' | 'calendar' | 'graph';

interface NodeWithProperty {
  node: Node;
  propertyValue: unknown;
}

/**
 * Hook to fetch nodes with a specific property using property ID
 */
function useNodesWithProperty(propertyId: number | null) {
  return useQuery({
    queryKey: ['property-nodes', propertyId],
    queryFn: async () => {
      if (!propertyId) return [];
      
      // Use the dedicated API endpoint that queries by property ID
      const response = await getNodesWithProperty(propertyId);
      
      // Convert API response to NodeWithProperty format
      return response.nodes.map(item => ({
        node: {
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
        } as Node,
        propertyValue: item.property_value,
      }));
    },
    enabled: !!propertyId,
    staleTime: 30000,
  });
}

/**
 * View mode selector buttons
 */
function ViewModeSelector({
  mode,
  onChange,
}: {
  mode: PropertyViewMode;
  onChange: (mode: PropertyViewMode) => void;
}) {
  const modes: { value: PropertyViewMode; label: string }[] = [
    { value: 'list', label: 'List' },
    { value: 'cards', label: 'Cards' },
    { value: 'calendar', label: 'Calendar' },
    { value: 'graph', label: 'Graph' },
  ];
  
  return (
    <div className="property-nodes-view__mode-selector">
      {modes.map((m) => (
        <Button
          key={m.value}
          className="property-nodes-view__mode-btn"
          variant={mode === m.value ? 'default' : 'ghost'}
          size="sm"
          active={mode === m.value}
          onClick={() => onChange(m.value)}
        >
          {m.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * List view for nodes with property
 */
function PropertyNodesList({
  nodes,
  property,
  onNodeClick,
}: {
  nodes: NodeWithProperty[];
  property: Property;
  onNodeClick?: (node: Node) => void;
}) {
  const { openNode } = useNodesStore();
  
  const handleClick = useCallback((node: Node) => {
    if (onNodeClick) {
      onNodeClick(node);
    } else {
      openNode(node.id, node.is_page ? 'page' : 'block');
    }
  }, [onNodeClick, openNode]);
  
  return (
    <div className="property-nodes-view__list">
      {nodes.map(({ node, propertyValue }) => {
        const isPage = node.is_page;
        
        return (
          <Button
            key={node.id}
            className="property-nodes-view__item"
            variant="ghost"
            size="sm"
            onClick={() => handleClick(node)}
          >
            <span className="property-nodes-view__item-icon">
              {isPage ? (
                <NodeIcon icon={node.icon} isPage={true} size="sm" />
              ) : (
                <BulletIcon size="xs" />
              )}
            </span>
            <span className="property-nodes-view__item-name">
              {node.name || 'Untitled'}
            </span>
            <span className="property-nodes-view__item-value">
              {property.type === 'boolean' ? (
                <input 
                  type="checkbox" 
                  checked={Boolean(propertyValue)} 
                  disabled 
                  readOnly 
                  className="property-nodes-view__checkbox"
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                formatPropertyValue(propertyValue, property.type)
              )}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

/**
 * Format property value for display
 */
function formatPropertyValue(value: unknown, type: string): string {
  if (value === null || value === undefined) return '—';
  
  switch (type) {
    case 'boolean':
      // Note: This function returns strings for display in text contexts
      // For actual boolean inputs, the PropertyValue component uses checkboxes
      return value ? 'Yes' : 'No';
    case 'date':
      if (typeof value === 'string') {
        return new Date(value).toLocaleDateString();
      }
      return String(value);
    case 'node':
      if (typeof value === 'object' && value !== null && 'name' in value) {
        return (value as { name: string }).name || 'Untitled';
      }
      if (Array.isArray(value)) {
        return value.map(v => typeof v === 'object' && v && 'name' in v ? v.name : '').filter(Boolean).join(', ') || '—';
      }
      return String(value);
    case 'selection':
      if (Array.isArray(value)) {
        return value.map(v => typeof v === 'object' && v && 'name' in v ? v.name : String(v)).join(', ');
      }
      if (typeof value === 'object' && value !== null && 'name' in value) {
        return (value as { name: string }).name;
      }
      return String(value);
    default:
      return String(value);
  }
}

/**
 * PropertyNodesView Component
 */
export function PropertyNodesView({
  property,
  initialViewMode = 'list',
  showViewModeSelector = true,
  title,
  limit = 0,
  onNodeClick,
}: PropertyNodesViewProps) {
  const [viewMode, setViewMode] = useState<PropertyViewMode>(initialViewMode);
  const { data: nodesWithProperty = [], isLoading, error } = useNodesWithProperty(property.id);
  
  // Apply limit if specified
  const displayNodes = useMemo(() => {
    if (limit > 0) {
      return nodesWithProperty.slice(0, limit);
    }
    return nodesWithProperty;
  }, [nodesWithProperty, limit]);
  
  // Extract just the nodes for view components
  const nodes = useMemo(() => displayNodes.map(n => n.node), [displayNodes]);
  
  // Loading state
  if (isLoading) {
    return (
      <div className="property-nodes-view property-nodes-view--loading">
        <div className="property-nodes-view__loading">Loading nodes...</div>
      </div>
    );
  }
  
  // Error state
  if (error) {
    return (
      <div className="property-nodes-view property-nodes-view--error">
        <div className="property-nodes-view__error">
          Failed to load nodes with this property
        </div>
      </div>
    );
  }
  
  // Empty state
  if (nodes.length === 0) {
    return (
      <div className="property-nodes-view property-nodes-view--empty">
        <div className="property-nodes-view__empty">
          No nodes have the "{property.name}" property
        </div>
      </div>
    );
  }
  
  return (
    <div className="property-nodes-view">
      <div className="property-nodes-view__header">
        <h3 className="property-nodes-view__title">
          {title || `Nodes with "${property.name}"`}
          <span className="property-nodes-view__count">
            ({nodes.length}{limit > 0 && nodes.length >= limit ? '+' : ''})
          </span>
        </h3>
        {showViewModeSelector && (
          <ViewModeSelector mode={viewMode} onChange={setViewMode} />
        )}
      </div>
      
      <div className="property-nodes-view__content">
        {viewMode === 'list' && (
          <PropertyNodesList
            nodes={displayNodes}
            property={property}
            onNodeClick={onNodeClick}
          />
        )}
        
        {viewMode === 'cards' && (
          <NodeCollection
            nodes={nodes}
            viewMode="card"
            sortable={false}
            onNodeClick={onNodeClick}
          />
        )}
        
        {viewMode === 'graph' && (
          <NodeGraphViewSimple
            nodes={nodes.filter(n => n.is_page).map(n => ({
              id: n.id,
              name: n.name || 'Untitled',
              title: n.name || 'Untitled',
              type: 'page' as const,
              tags: n.tags?.map(t => String(t)) || [],
              properties: {},
              is_daily: n.is_daily || false,
            }))}
            links={[]}
            className="property-nodes-view__graph"
          />
        )}
      </div>
    </div>
  );
}

export default PropertyNodesView;
