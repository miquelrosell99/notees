/**
 * NodeListCore Component
 * 
 * A component for displaying lists of nodes with optional grouping.
 * Uses the useNodeCollection hook for grouping/collapsing logic.
 * 
 * Note: This component was moved out of core/ because it has domain knowledge
 * (depends on the Node type).
 */
import { useMemo, useCallback, type ReactNode } from 'react';
import type { Node } from '@/types/api';
import { useNodeCollection, type CollectionItem } from '@/hooks';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import { Bullet } from '../blocks/Bullet';
import { BlockContent } from '../blocks/BlockContent';
import { NodeIcon, ChevronDownIcon, ChevronRightIcon } from '../icons';
import './NodeListCore.css';

// ==================== Types ====================

export interface NodeListCoreItem<T = Node> {
  /** The node to display */
  node: T;
  /** Custom metadata for grouping/sorting */
  meta?: Record<string, unknown>;
}

export interface NodeListCoreGroup<T = Node> {
  /** Unique key for the group */
  key: string;
  /** Display label */
  label: string;
  /** Optional icon */
  icon?: ReactNode;
  /** Items in this group */
  items: NodeListCoreItem<T>[];
}

export interface NodeListCoreProps<T = Node> {
  /** Items to display */
  items: NodeListCoreItem<T>[];
  /** Optional groupBy function */
  groupBy?: (item: NodeListCoreItem<T>) => string;
  /** Group labels (key -> label mapping) */
  groupLabels?: Record<string, string>;
  /** Group icons (key -> icon mapping) */
  groupIcons?: Record<string, ReactNode>;
  /** Sort groups */
  sortGroups?: (a: string, b: string) => number;
  /** Sort items within groups */
  sortItems?: (a: NodeListCoreItem<T>, b: NodeListCoreItem<T>) => number;
  /** Whether groups are collapsible */
  collapsibleGroups?: boolean;
  /** Initially collapsed groups */
  defaultCollapsedGroups?: string[];
  /** Item click handler */
  onItemClick?: (item: NodeListCoreItem<T>) => void;
  /** Item shift-click handler */
  onItemShiftClick?: (item: NodeListCoreItem<T>) => void;
  /** Custom item renderer */
  renderItem?: (item: NodeListCoreItem<T>, index: number) => ReactNode;
  /** Custom group header renderer */
  renderGroupHeader?: (group: NodeListCoreGroup<T>) => ReactNode;
  /** Empty state content */
  emptyContent?: ReactNode;
  /** Loading state */
  loading?: boolean;
  /** Show item icons */
  showIcons?: boolean;
  /** Show item bullets */
  showBullets?: boolean;
  /** Additional className */
  className?: string;
  /** Variant */
  variant?: 'default' | 'compact' | 'card';
}

// ==================== Component ====================

/**
 * NodeListCore component with optional grouping support.
 * Uses useNodeCollection hook for grouping/collapsing logic.
 */
export function NodeListCore<T extends Node = Node>({
  items,
  groupBy: groupByProp,
  groupLabels = {},
  groupIcons = {},
  sortGroups,
  sortItems: sortItemsProp,
  collapsibleGroups = true,
  defaultCollapsedGroups = [],
  onItemClick,
  onItemShiftClick,
  renderItem,
  renderGroupHeader,
  emptyContent = 'No items',
  loading = false,
  showIcons = true,
  showBullets = true,
  className = '',
  variant = 'default',
}: NodeListCoreProps<T>) {
  // Convert items to CollectionItem format
  const collectionItems = useMemo<CollectionItem<NodeListCoreItem<T>>[]>(() => 
    items.map(item => ({ data: item, meta: item.meta })),
    [items]
  );

  // Adapter for groupBy function
  const groupBy = useMemo(() => {
    if (!groupByProp) return undefined;
    return (item: CollectionItem<NodeListCoreItem<T>>) => groupByProp(item.data);
  }, [groupByProp]);

  // Adapter for sortItems function
  const sortItems = useMemo(() => {
    if (!sortItemsProp) return undefined;
    return (a: CollectionItem<NodeListCoreItem<T>>, b: CollectionItem<NodeListCoreItem<T>>) => 
      sortItemsProp(a.data, b.data);
  }, [sortItemsProp]);

  // Use the shared hook for grouping/collapsing logic
  const { groups, toggleGroup, isCollapsed, isEmpty } = useNodeCollection({
    items: collectionItems,
    groupBy,
    groupLabels,
    groupIcons,
    sortGroups,
    sortItems,
    collapsible: collapsibleGroups,
    defaultCollapsed: defaultCollapsedGroups,
  });

  // Handle item click with shift detection
  const handleItemClick = useCallback((item: NodeListCoreItem<T>, e: React.MouseEvent) => {
    if (e.shiftKey && onItemShiftClick) {
      e.preventDefault();
      onItemShiftClick(item);
    } else if (onItemClick) {
      onItemClick(item);
    }
  }, [onItemClick, onItemShiftClick]);

  // Build class names
  const containerClasses = [
    'node-list-core',
    `node-list-core--${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  // Loading state
  if (loading) {
    return (
      <div className={`${containerClasses} node-list-core--loading`}>
        <div className="node-list-core__loading">Loading...</div>
      </div>
    );
  }

  // Empty state
  if (isEmpty) {
    return (
      <div className={`${containerClasses} node-list-core--empty`}>
        <div className="node-list-core__empty">{emptyContent}</div>
      </div>
    );
  }

  // Convert CollectionGroup to NodeListCoreGroup for rendering
  const convertedGroups: Array<NodeListCoreGroup<T> & { collapsed: boolean }> = groups.map(g => ({
    key: g.key,
    label: g.label,
    icon: g.icon,
    items: g.items.map(i => i.data),
    collapsed: g.collapsed,
  }));

  return (
    <div className={containerClasses}>
      {convertedGroups.map(group => {
        const showHeader = groupByProp && group.label;

        return (
          <div key={group.key} className="node-list-core__group">
            {showHeader && (
              renderGroupHeader ? (
                renderGroupHeader(group)
              ) : (
                <button
                  className="node-list-core__group-header"
                  onClick={() => collapsibleGroups && toggleGroup(group.key)}
                  disabled={!collapsibleGroups}
                >
                  {collapsibleGroups && (
                    isCollapsed(group.key) ? <ChevronRightIcon size="xs" /> : <ChevronDownIcon size="xs" />
                  )}
                  {group.icon && <span className="node-list-core__group-icon">{group.icon}</span>}
                  <span className="node-list-core__group-label">{group.label}</span>
                  <span className="node-list-core__group-count">({group.items.length})</span>
                </button>
              )
            )}

            {!isCollapsed(group.key) && (
              <div className="node-list-core__items">
                {group.items.map((item, index) => (
                  renderItem ? (
                    <div key={item.node.id} onClick={(e) => handleItemClick(item, e)}>
                      {renderItem(item, index)}
                    </div>
                  ) : (
                    <NodeListCoreDefaultItem
                      key={item.node.id}
                      item={item}
                      onClick={(e) => handleItemClick(item, e)}
                      showIcon={showIcons}
                      showBullet={showBullets}
                      variant={variant}
                    />
                  )
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ==================== Default Item Component ====================

interface NodeListCoreDefaultItemProps<T extends Node> {
  item: NodeListCoreItem<T>;
  onClick: (e: React.MouseEvent) => void;
  showIcon: boolean;
  showBullet: boolean;
  variant: 'default' | 'compact' | 'card';
}

function NodeListCoreDefaultItem<T extends Node>({
  item,
  onClick,
  showIcon,
  showBullet,
  variant,
}: NodeListCoreDefaultItemProps<T>) {
  const { node } = item;
  
  const itemContent = (
    <>
      {showBullet && (
        <Bullet
          size="sm"
          interactive={false}
        />
      )}
      {showIcon && (
        <NodeIcon
          icon={node.icon}
          isPage={node.is_page}
          size="sm"
        />
      )}
      <span className="node-list-core__item-name">
        <BlockContent
          content={node.name || 'Untitled'}
        />
      </span>
    </>
  );

  if (variant === 'card') {
    return (
      <Card
        className="node-list-core__item node-list-core__item--card"
        onClick={onClick}
        interactive
        padding
        paddingSize="sm"
        elevation="low"
      >
        {itemContent}
      </Card>
    );
  }

  return (
    <Button variant="ghost" className="node-list-core__item" onClick={onClick}>
      {itemContent}
    </Button>
  );
}

export default NodeListCore;
