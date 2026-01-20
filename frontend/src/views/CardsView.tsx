/**
 * CardsView - Kanban/Cards view with configurable property grouping
 * 
 * Displays nodes as cards grouped by a property value.
 * Useful for task management, status tracking, etc.
 * Supports cover images with different layouts.
 */
import { useState, useMemo, useCallback } from 'react';
import './CardsView.css';
import type { Node, Property } from '@/types/api';
import { CardViewCard, type CardLayout } from '../components/CardViewCard';
import '../components/CardViewCard.css';

export type CardsViewMode = 'cards' | 'kanban';

export interface CardsViewProps {
  /** Nodes to display */
  nodes: Node[];
  /** Available properties for grouping */
  properties?: Property[];
  /** Currently selected group-by property ID */
  groupByPropertyId?: number | null;
  /** Callback when group-by property changes */
  onGroupByChange?: (propertyId: number | null) => void;
  /** Callback when a card is clicked */
  onCardClick?: (nodeId: number) => void;
  /** Callback when a card is shift+clicked */
  onCardShiftClick?: (nodeId: number) => void;
  /** View mode */
  mode?: CardsViewMode;
  /** Card layout (cover style) */
  cardLayout?: CardLayout;
  /** Callback when card layout changes */
  onCardLayoutChange?: (layout: CardLayout) => void;
  /** Cover property name to use for cover images */
  coverPropertyName?: string;
  /** Extra CSS class */
  className?: string;
  /** Title for the view */
  title?: string;
}

interface CardColumn {
  id: string;
  label: string;
  nodes: Node[];
}

/**
 * Get property value from node for grouping
 */
function getPropertyValue(node: Node, propertyId: number, properties: Property[]): string {
  const prop = properties.find(p => p.id === propertyId);
  if (!prop || !node.properties) return 'Ungrouped';
  
  const propKey = prop.name.toLowerCase().replace(/\s+/g, '_');
  const value = (node.properties as Record<string, unknown>)[propKey];
  
  if (value === null || value === undefined) return 'Ungrouped';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/**
 * Get cover image from node's properties or content
 */
function getCoverFromNode(node: Node, coverPropertyName?: string): string | null {
  // First check if there's a cover property
  if (coverPropertyName && node.properties) {
    const propKey = coverPropertyName.toLowerCase().replace(/\s+/g, '_');
    const coverValue = (node.properties as Record<string, unknown>)[propKey];
    if (coverValue && typeof coverValue === 'string') {
      return coverValue;
    }
  }
  
  // Otherwise, extract from content (handled by CardViewCard)
  return null;
}

/**
 * Group nodes by property value
 */
function groupNodesByProperty(
  nodes: Node[], 
  propertyId: number | null, 
  properties: Property[]
): CardColumn[] {
  if (!propertyId) {
    // No grouping - show all in one column
    return [{ id: 'all', label: 'All', nodes }];
  }
  
  const groups = new Map<string, Node[]>();
  
  for (const node of nodes) {
    const value = getPropertyValue(node, propertyId, properties);
    const existing = groups.get(value) ?? [];
    existing.push(node);
    groups.set(value, existing);
  }
  
  // Sort groups: Ungrouped last
  const entries = Array.from(groups.entries()).sort((a, b) => {
    if (a[0] === 'Ungrouped') return 1;
    if (b[0] === 'Ungrouped') return -1;
    return a[0].localeCompare(b[0]);
  });
  
  return entries.map(([label, nodes]) => ({
    id: label.toLowerCase().replace(/\s+/g, '-'),
    label,
    nodes,
  }));
}

/**
 * Column component for Kanban view
 */
function Column({ 
  column, 
  cardLayout,
  coverPropertyName,
  onCardClick,
  onCardShiftClick,
}: { 
  column: CardColumn; 
  cardLayout: CardLayout;
  coverPropertyName?: string;
  onCardClick?: (nodeId: number) => void;
  onCardShiftClick?: (nodeId: number) => void;
}) {
  return (
    <div className="cards-view__column">
      <div className="cards-view__column-header">
        <span className="cards-view__column-title">{column.label}</span>
        <span className="cards-view__column-count">{column.nodes.length}</span>
      </div>
      <div className="cards-view__column-cards">
        {column.nodes.map(node => (
          <CardViewCard
            key={node.id}
            node={node}
            layout={cardLayout}
            cover={getCoverFromNode(node, coverPropertyName)}
            onClick={() => onCardClick?.(node.id)}
            onShiftClick={() => onCardShiftClick?.(node.id)}
          />
        ))}
        {column.nodes.length === 0 && (
          <div className="cards-view__column-empty">No items</div>
        )}
      </div>
    </div>
  );
}

/**
 * Property selector for grouping
 */
function GroupBySelector({
  properties,
  selectedId,
  onChange,
}: {
  properties: Property[];
  selectedId: number | null;
  onChange: (id: number | null) => void;
}) {
  // Filter to selection/text/boolean properties that make sense for grouping
  const groupableProps = properties.filter(p => 
    p.type === 'selection' || p.type === 'text' || p.type === 'boolean'
  );
  
  return (
    <div className="cards-view__group-by">
      <label className="cards-view__group-by-label">Group by</label>
      <select 
        className="cards-view__group-by-select"
        value={selectedId ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">None</option>
        {groupableProps.map(prop => (
          <option key={prop.id} value={prop.id}>
            {prop.icon ? `${prop.icon} ` : ''}{prop.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Card layout selector
 */
function CardLayoutSelector({
  layout,
  onChange,
}: {
  layout: CardLayout;
  onChange: (layout: CardLayout) => void;
}) {
  return (
    <div className="cards-view__layout-selector">
      <button 
        className={`cards-view__layout-btn ${layout === 'no-cover' ? 'cards-view__layout-btn--active' : ''}`}
        onClick={() => onChange('no-cover')}
        title="No cover"
      >
        <span className="layout-icon layout-icon--no-cover">
          <span className="layout-icon__content"></span>
        </span>
      </button>
      <button 
        className={`cards-view__layout-btn ${layout === 'cover-top' ? 'cards-view__layout-btn--active' : ''}`}
        onClick={() => onChange('cover-top')}
        title="Cover on top"
      >
        <span className="layout-icon layout-icon--cover-top">
          <span className="layout-icon__cover"></span>
          <span className="layout-icon__content"></span>
        </span>
      </button>
      <button 
        className={`cards-view__layout-btn ${layout === 'cover-side' ? 'cards-view__layout-btn--active' : ''}`}
        onClick={() => onChange('cover-side')}
        title="Cover on side"
      >
        <span className="layout-icon layout-icon--cover-side">
          <span className="layout-icon__cover"></span>
          <span className="layout-icon__content"></span>
        </span>
      </button>
    </div>
  );
}

/**
 * Cards/Kanban View
 */
export function CardsView({
  nodes,
  properties = [],
  groupByPropertyId = null,
  onGroupByChange,
  onCardClick,
  onCardShiftClick,
  mode = 'kanban',
  cardLayout: externalCardLayout,
  onCardLayoutChange,
  coverPropertyName,
  className = '',
  title = 'Cards',
}: CardsViewProps) {
  const [internalGroupBy, setInternalGroupBy] = useState<number | null>(groupByPropertyId);
  const [internalCardLayout, setInternalCardLayout] = useState<CardLayout>('cover-top');
  
  const effectiveGroupBy = onGroupByChange ? groupByPropertyId : internalGroupBy;
  const handleGroupByChange = onGroupByChange ?? setInternalGroupBy;
  
  const effectiveCardLayout = externalCardLayout ?? internalCardLayout;
  const handleCardLayoutChange = useCallback((layout: CardLayout) => {
    if (onCardLayoutChange) {
      onCardLayoutChange(layout);
    } else {
      setInternalCardLayout(layout);
    }
  }, [onCardLayoutChange]);
  
  const columns = useMemo(
    () => groupNodesByProperty(nodes, effectiveGroupBy, properties),
    [nodes, effectiveGroupBy, properties]
  );
  
  if (nodes.length === 0) {
    return (
      <div className={`cards-view cards-view--empty ${className}`}>
        <p className="cards-view__empty">No items to display</p>
      </div>
    );
  }
  
  return (
    <div className={`cards-view cards-view--${mode} ${className}`}>
      <div className="cards-view__header">
        <h3 className="cards-view__title">{title}</h3>
        <div className="cards-view__controls">
          <CardLayoutSelector 
            layout={effectiveCardLayout} 
            onChange={handleCardLayoutChange} 
          />
          {properties.length > 0 && (
            <GroupBySelector
              properties={properties}
              selectedId={effectiveGroupBy}
              onChange={handleGroupByChange}
            />
          )}
        </div>
      </div>
      
      <div className="cards-view__content">
        {mode === 'kanban' ? (
          <div className="cards-view__columns">
            {columns.map(column => (
              <Column 
                key={column.id} 
                column={column} 
                cardLayout={effectiveCardLayout}
                coverPropertyName={coverPropertyName}
                onCardClick={onCardClick}
                onCardShiftClick={onCardShiftClick}
              />
            ))}
          </div>
        ) : (
          <div className="cards-view__grid">
            {nodes.map(node => (
              <CardViewCard
                key={node.id}
                node={node}
                layout={effectiveCardLayout}
                cover={getCoverFromNode(node, coverPropertyName)}
                onClick={() => onCardClick?.(node.id)}
                onShiftClick={() => onCardShiftClick?.(node.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default CardsView;
