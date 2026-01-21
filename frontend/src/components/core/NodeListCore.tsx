/**
 * NodeListCore Component
 * 
 * A core component for displaying lists of nodes with optional grouping.
 * This is a simpler, more reusable version extracted from NodeList.
 */
import { useState, useMemo, useCallback, type ReactNode } from 'react';
import type { Node } from '@/types/api';
import { Card } from './Card';
import { Button } from './Button';
import { Bullet } from '../Bullet';
import { BlockContent } from '../BlockContent';
import { NodeIcon, ChevronDownIcon, ChevronRightIcon } from '../icons';
import './NodeListCore.css';

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

/**
 * NodeListCore component with optional grouping support.
 */
export function NodeListCore<T extends Node = Node>({
  items,
  groupBy,
  groupLabels = {},
  groupIcons = {},
  sortGroups,
  sortItems,
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
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(defaultCollapsedGroups)
  );

  // Group items if groupBy function is provided
  const groups = useMemo((): NodeListCoreGroup<T>[] => {
    if (!groupBy) {
      // No grouping - single group with all items
      return [{
        key: '__all__',
        label: '',
        items: sortItems ? [...items].sort(sortItems) : items,
      }];
    }

    const groupMap = new Map<string, NodeListCoreItem<T>[]>();
    
    for (const item of items) {
      const key = groupBy(item);
      if (!groupMap.has(key)) {
        groupMap.set(key, []);
      }
      groupMap.get(key)!.push(item);
    }

    let groupKeys = Array.from(groupMap.keys());
    if (sortGroups) {
      groupKeys = groupKeys.sort(sortGroups);
    }

    return groupKeys.map(key => {
      let groupItems = groupMap.get(key)!;
      if (sortItems) {
        groupItems = [...groupItems].sort(sortItems);
      }
      return {
        key,
        label: groupLabels[key] || key,
        icon: groupIcons[key],
        items: groupItems,
      };
    });
  }, [items, groupBy, groupLabels, groupIcons, sortGroups, sortItems]);

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleItemClick = useCallback((item: NodeListCoreItem<T>, e: React.MouseEvent) => {
    if (e.shiftKey && onItemShiftClick) {
      e.preventDefault();
      onItemShiftClick(item);
    } else if (onItemClick) {
      onItemClick(item);
    }
  }, [onItemClick, onItemShiftClick]);

  const containerClasses = [
    'node-list-core',
    `node-list-core--${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  if (loading) {
    return (
      <div className={`${containerClasses} node-list-core--loading`}>
        <div className="node-list-core__loading">Loading...</div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className={`${containerClasses} node-list-core--empty`}>
        <div className="node-list-core__empty">{emptyContent}</div>
      </div>
    );
  }

  return (
    <div className={containerClasses}>
      {groups.map(group => {
        const isCollapsed = collapsedGroups.has(group.key);
        const showHeader = groupBy && group.label;

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
                    isCollapsed ? <ChevronRightIcon size="xs" /> : <ChevronDownIcon size="xs" />
                  )}
                  {group.icon && <span className="node-list-core__group-icon">{group.icon}</span>}
                  <span className="node-list-core__group-label">{group.label}</span>
                  <span className="node-list-core__group-count">({group.items.length})</span>
                </button>
              )
            )}

            {!isCollapsed && (
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
