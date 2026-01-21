/**
 * NodeSet Component
 * 
 * A container for displaying a set of nodes with different view types.
 * Features:
 * - SelectionButton in header for view type toggle (table, list, card)
 * - Header with left, center, and right sections
 * - Container for the corresponding view
 * - Group by support with ButtonWithPanel settings
 * - Two-section list view: Pages first, then Blocks grouped by page
 */
import { useState, useCallback, useMemo, type ReactNode } from 'react';
import type { Node } from '@/types';
import { useTypes } from '@/hooks';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { NodeIcon, ChevronRightIcon, ChevronDownIcon } from './icons';
import { Button } from './core/Button';
import { ButtonWithPanel } from './core/ButtonWithPanel';
import { SelectionButton } from './core/SelectionButton';
import { BlockContent } from './blocks/BlockContent';
import { Block } from './blocks/Block';
import { CardViewCard } from './CardViewCard';
import { mdiTune, mdiFormatListBulleted, mdiTable, mdiViewGrid } from '@mdi/js';
import './NodeSet.css';

// View types
export type NodeSetViewType = 'list' | 'table' | 'card';

// View type icon and label mapping
const VIEW_TYPE_OPTIONS: Record<NodeSetViewType, { icon: string; label: string }> = {
  list: { icon: mdiFormatListBulleted, label: 'List view' },
  table: { icon: mdiTable, label: 'Table view' },
  card: { icon: mdiViewGrid, label: 'Card view' },
};

// Node item for list/table views
export interface NodeSetItem {
  node: Node;
  /** Optional additional context (e.g., parent page name) */
  context?: string;
  /** Optional badge/count */
  badge?: number | string;
  /** Optional page reference (for grouping) */
  page?: Node | null;
}

// Group by options
export type GroupByOption = 'none' | 'page' | 'type' | 'date';

// Grouped items structure
interface NodeSetGroup {
  key: string;
  label: string;
  icon?: ReactNode;
  items: NodeSetItem[];
  collapsed?: boolean;
}

export interface NodeSetProps {
  /** Items to display */
  items: NodeSetItem[];
  /** Title for the section */
  title?: string;
  /** Icon to show in title */
  titleIcon?: ReactNode;
  /** Controlled view type (overrides defaultViewType when provided) */
  viewType?: NodeSetViewType;
  /** Default view type (used when viewType is not controlled) */
  defaultViewType?: NodeSetViewType;
  /** Available view types */
  viewTypes?: NodeSetViewType[];
  /** Called when a node is clicked */
  onNodeClick?: (node: Node) => void;
  /** Called when a node is shift-clicked (open in sidebar) */
  onNodeShiftClick?: (node: Node) => void;
  /** Extra content for the left section of the header */
  headerLeft?: ReactNode;
  /** Extra content for the center section of the header */
  headerCenter?: ReactNode;
  /** Extra content for the right section of the header (before the view switch) */
  headerRightExtra?: ReactNode;
  /** Whether to show empty state */
  showEmpty?: boolean;
  /** Empty state message */
  emptyMessage?: string;
  /** Additional CSS class */
  className?: string;
  /** Whether to show the header (default: true) */
  showHeader?: boolean;
  /** Whether to show the view type toggle */
  showViewToggle?: boolean;
  /** Default group by option */
  defaultGroupBy?: GroupByOption;
  /** Available group by options */
  groupByOptions?: GroupByOption[];
  /** Whether to show group by settings */
  showGroupBySettings?: boolean;
  /** Map of page IDs to page names for grouping */
  pageMap?: Map<number, Node>;
  /** Whether to show breadcrumbs for blocks in list view (default: false) */
  showBreadcrumbs?: boolean;
  /** Breadcrumb data for blocks - maps node ID to breadcrumb segments */
  breadcrumbMap?: Map<number, { pageId: number; pageName: string; pageIcon?: string | null }>;
  /** Callback when block content changes (enables editing) */
  onContentChange?: (blockId: number, content: string) => void;
}

// Group Settings Panel
interface GroupSettingsPanelProps {
  groupBy: GroupByOption;
  onChange: (value: GroupByOption) => void;
  options: GroupByOption[];
}

function GroupSettingsPanel({ groupBy, onChange, options }: GroupSettingsPanelProps) {
  const labelMap: Record<GroupByOption, string> = {
    none: 'No grouping',
    page: 'Group by page',
    type: 'Group by type',
    date: 'Group by date',
  };
  
  return (
    <div className="node-set__group-settings">
      <div className="node-set__group-settings-label">Group by</div>
      <div className="node-set__group-options">
        {options.map((option) => (
          <label key={option} className="node-set__group-option">
            <input
              type="radio"
              name="groupBy"
              value={option}
              checked={groupBy === option}
              onChange={() => onChange(option)}
            />
            <span>{labelMap[option]}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// Breadcrumb component for blocks
interface BlockBreadcrumbProps {
  pageName: string;
  pageIcon?: string | null;
  onPageClick?: () => void;
}

function BlockBreadcrumb({ pageName, pageIcon, onPageClick }: BlockBreadcrumbProps) {
  return (
    <div className="node-set__breadcrumb">
      <Button 
        variant="ghost"
        size="xs"
        className="node-set__breadcrumb-link"
        onClick={(e) => {
          e.stopPropagation();
          onPageClick?.();
        }}
      >
        <NodeIcon icon={pageIcon} isPage={true} size="xs" />
        <span className="node-set__breadcrumb-name">{pageName}</span>
      </Button>
    </div>
  );
}

// List Item Component (reusable for both grouped and ungrouped views)
interface ListItemProps {
  item: NodeSetItem;
  depth?: number;
  allTypes?: Node[] | null;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  /** Optional breadcrumb info for blocks */
  breadcrumb?: { pageName: string; pageIcon?: string | null; onPageClick?: () => void };
  /** Callback when block content changes (enables editing) */
  onContentChange?: (blockId: number, content: string) => void;
}

function NodeSetListItem({ item, depth = 0, allTypes, onNodeClick, onNodeShiftClick, breadcrumb, onContentChange }: ListItemProps) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (e.shiftKey && onNodeShiftClick) {
      onNodeShiftClick(item.node);
    } else if (onNodeClick) {
      onNodeClick(item.node);
    }
  }, [item.node, onNodeClick, onNodeShiftClick]);

  const handleContentChange = useCallback((blockId: number, content: string) => {
    onContentChange?.(blockId, content);
  }, [onContentChange]);

  const handleBulletClick = useCallback((blockId: number) => {
    const node = item.node.id === blockId ? item.node : null;
    if (node && onNodeClick) {
      onNodeClick(node);
    }
  }, [item.node, onNodeClick]);

  const handleShiftClick = useCallback((blockId: number) => {
    const node = item.node.id === blockId ? item.node : null;
    if (node && onNodeShiftClick) {
      onNodeShiftClick(node);
    }
  }, [item.node, onNodeShiftClick]);
  
  // For non-page items, render as editable Block
  if (!item.node.is_page) {
    return (
      <div className="node-set__list-item-wrapper">
        {breadcrumb && (
          <BlockBreadcrumb 
            pageName={breadcrumb.pageName}
            pageIcon={breadcrumb.pageIcon}
            onPageClick={breadcrumb.onPageClick}
          />
        )}
        <div className="node-set__block-wrapper">
          <Block
            block={item.node}
            parentId={item.node.parent_id}
            onContentChange={handleContentChange}
            onBulletClick={handleBulletClick}
            onShiftClick={handleShiftClick}
            showBullet={!!item.node.icon}
            depth={depth}
          />
        </div>
      </div>
    );
  }

  // For pages, render as clickable button
  return (
    <div className="node-set__list-item-wrapper">
      {breadcrumb && (
        <BlockBreadcrumb 
          pageName={breadcrumb.pageName}
          pageIcon={breadcrumb.pageIcon}
          onPageClick={breadcrumb.onPageClick}
        />
      )}
      <Button
        variant="ghost"
        className="node-set__list-item"
        style={{ paddingLeft: `calc(var(--spacing-3) + ${depth * 20}px)` }}
        onClick={handleClick}
        title={`${item.node.name || 'Untitled'}${item.context ? ` (${item.context})` : ''}`}
      >
        {/* Show icon for pages, or for blocks that have an icon set */}
        {(item.node.is_page || item.node.icon) && (
          <span className="node-set__item-icon">
            <NodeIcon icon={getEffectiveIcon(item.node, allTypes)} isPage={item.node.is_page} size="sm" />
          </span>
        )}
        <span className="node-set__item-content">
          <span className="node-set__item-name">
            {item.node.name ? (
              <BlockContent 
                content={item.node.name} 
                blockId={item.node.id}
              />
            ) : (
              item.node.display_name || 'Untitled'
            )}
          </span>
          {item.context && depth === 0 && (
            <span className="node-set__item-context">{item.context}</span>
          )}
        </span>
        {item.badge !== undefined && (
          <span className="node-set__item-badge">{item.badge}</span>
        )}
      </Button>
    </div>
  );
}

// Group Header Component
interface GroupHeaderProps {
  group: NodeSetGroup;
  collapsed: boolean;
  onToggle: () => void;
  onGroupClick?: () => void;
}

function GroupHeader({ group, collapsed, onToggle, onGroupClick }: GroupHeaderProps) {
  return (
    <div className="node-set__group-header">
      <Button 
        variant="ghost"
        size="xs"
        className="node-set__group-toggle"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        {collapsed ? <ChevronRightIcon size="xs" /> : <ChevronDownIcon size="xs" />}
      </Button>
      <Button 
        variant="ghost"
        className="node-set__group-label"
        onClick={onGroupClick}
      >
        {group.icon && <span className="node-set__group-icon">{group.icon}</span>}
        <span className="node-set__group-name">{group.label}</span>
        <span className="node-set__group-count">({group.items.length})</span>
      </Button>
    </div>
  );
}

// Grouped List View Component
interface GroupedListViewProps {
  groups: NodeSetGroup[];
  allTypes?: Node[] | null;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onGroupClick?: (groupKey: string) => void;
  onContentChange?: (blockId: number, content: string) => void;
}

function NodeSetGroupedListView({ 
  groups,
  allTypes,
  onNodeClick, 
  onNodeShiftClick,
  onGroupClick,
  onContentChange,
}: GroupedListViewProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  
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
  
  return (
    <div className="node-set__grouped-list">
      {groups.map((group) => {
        const isCollapsed = collapsedGroups.has(group.key);
        return (
          <div key={group.key} className="node-set__group">
            <GroupHeader
              group={group}
              collapsed={isCollapsed}
              onToggle={() => toggleGroup(group.key)}
              onGroupClick={() => onGroupClick?.(group.key)}
            />
            {!isCollapsed && (
              <div className="node-set__group-items">
                {group.items.map((item) => (
                  <NodeSetListItem
                    key={item.node.id}
                    item={item}
                    depth={1}
                    allTypes={allTypes}
                    onNodeClick={onNodeClick}
                    onNodeShiftClick={onNodeShiftClick}
                    onContentChange={onContentChange}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Two-Section List View Component (Pages first, then Blocks with breadcrumbs)
interface TwoSectionListViewProps {
  items: NodeSetItem[];
  allTypes?: Node[] | null;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  pageMap?: Map<number, Node>;
  onContentChange?: (blockId: number, content: string) => void;
}

function NodeSetTwoSectionListView({ 
  items,
  allTypes,
  onNodeClick, 
  onNodeShiftClick,
  pageMap,
  onContentChange,
}: TwoSectionListViewProps) {
  // Separate pages and blocks
  const { pages, blocks } = useMemo(() => {
    const pages: NodeSetItem[] = [];
    const blocks: NodeSetItem[] = [];
    
    for (const item of items) {
      if (item.node.is_page) {
        pages.push(item);
      } else {
        blocks.push(item);
      }
    }
    
    return { pages, blocks };
  }, [items]);
  
  // Group blocks by page
  const blockGroups = useMemo(() => {
    const groups = new Map<number | null, NodeSetItem[]>();
    
    for (const item of blocks) {
      const pageId = item.node.page_id;
      if (!groups.has(pageId)) {
        groups.set(pageId, []);
      }
      groups.get(pageId)!.push(item);
    }
    
    return groups;
  }, [blocks]);
  
  return (
    <div className="node-set__two-section-list">
      {/* Pages Section */}
      {pages.length > 0 && (
        <div className="node-set__section node-set__section--pages">
          <h4 className="node-set__section-title">Pages ({pages.length})</h4>
          <div className="node-set__list">
            {pages.map((item) => (
              <NodeSetListItem
                key={item.node.id}
                item={item}
                allTypes={allTypes}
                onNodeClick={onNodeClick}
                onNodeShiftClick={onNodeShiftClick}
                onContentChange={onContentChange}
              />
            ))}
          </div>
        </div>
      )}
      
      {/* Blocks Section */}
      {blocks.length > 0 && (
        <div className="node-set__section node-set__section--blocks">
          {pages.length > 0 && (
            <h4 className="node-set__section-title">Blocks ({blocks.length})</h4>
          )}
          <div className="node-set__blocks-list">
            {Array.from(blockGroups.entries()).map(([pageId, groupItems]) => {
              const page = pageId ? pageMap?.get(pageId) : null;
              const pageName = page?.name || 'Untitled';
              const pageIcon = page?.icon;
              
              return groupItems.map((item) => (
                <NodeSetListItem
                  key={item.node.id}
                  item={item}
                  allTypes={allTypes}
                  onNodeClick={onNodeClick}
                  onNodeShiftClick={onNodeShiftClick}
                  onContentChange={onContentChange}
                  breadcrumb={{
                    pageName,
                    pageIcon,
                    onPageClick: page ? () => onNodeClick?.(page) : undefined,
                  }}
                />
              ));
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// List View Component (simple, no grouping)
function NodeSetListView({ 
  items,
  allTypes,
  onNodeClick, 
  onNodeShiftClick,
  onContentChange,
}: { 
  items: NodeSetItem[];
  allTypes?: Node[] | null;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onContentChange?: (blockId: number, content: string) => void;
}) {
  return (
    <div className="node-set__list">
      {items.map((item) => (
        <NodeSetListItem
          key={item.node.id}
          item={item}
          allTypes={allTypes}
          onNodeClick={onNodeClick}
          onNodeShiftClick={onNodeShiftClick}
          onContentChange={onContentChange}
        />
      ))}
    </div>
  );
}

// Table View Component
function NodeSetTableView({ 
  items,
  allTypes,
  onNodeClick, 
  onNodeShiftClick 
}: { 
  items: NodeSetItem[];
  allTypes?: Node[] | null;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
}) {
  const handleClick = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    if (e.shiftKey && onNodeShiftClick) {
      onNodeShiftClick(node);
    } else if (onNodeClick) {
      onNodeClick(node);
    }
  }, [onNodeClick, onNodeShiftClick]);
  
  return (
    <div className="node-set__table-container">
      <table className="node-set__table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            {items.some(i => i.context) && <th>Context</th>}
            {items.some(i => i.badge !== undefined) && <th>#</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr 
              key={item.node.id}
              onClick={(e) => handleClick(e, item.node)}
              className="node-set__table-row"
            >
              <td>
                <span className="node-set__table-name">
                  {/* Show icon for pages, or for blocks that have an icon set */}
                  {(item.node.is_page || item.node.icon) && (
                    <span className="node-set__item-icon">
                      <NodeIcon icon={getEffectiveIcon(item.node, allTypes)} isPage={item.node.is_page} size="xs" />
                    </span>
                  )}
                  {item.node.name || item.node.display_name || 'Untitled'}
                </span>
              </td>
              <td>
                <span className={`node-set__type-badge node-set__type-badge--${item.node.is_page ? 'page' : 'block'}`}>
                  {item.node.is_page ? 'page' : 'block'}
                </span>
              </td>
              {items.some(i => i.context) && <td>{item.context || '—'}</td>}
              {items.some(i => i.badge !== undefined) && <td>{item.badge ?? '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Card View Component
function NodeSetCardView({ 
  items,
  onNodeClick, 
  onNodeShiftClick 
}: { 
  items: NodeSetItem[];
  allTypes?: Node[] | null;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
}) {
  return (
    <div className="node-set__cards">
      {items.map((item) => (
        <CardViewCard
          key={item.node.id}
          node={item.node}
          layout="cover-top"
          onClick={() => onNodeClick?.(item.node)}
          onShiftClick={() => onNodeShiftClick?.(item.node)}
          className="node-set__card"
        />
      ))}
    </div>
  );
}

// Main NodeSet Component
export function NodeSet({
  items,
  title,
  titleIcon,
  viewType: controlledViewType,
  defaultViewType = 'list',
  viewTypes = ['list', 'table', 'card'],
  onNodeClick,
  onNodeShiftClick,
  headerLeft,
  headerCenter,
  headerRightExtra,
  showEmpty = false,
  emptyMessage = 'No items',
  className = '',
  showHeader = true,
  showViewToggle = true,
  defaultGroupBy = 'page',
  groupByOptions = ['none', 'page'],
  showGroupBySettings = true,
  pageMap,
  onContentChange,
}: NodeSetProps) {
  const [internalViewType, setInternalViewType] = useState<NodeSetViewType>(defaultViewType);
  const [groupBy, setGroupBy] = useState<GroupByOption>(defaultGroupBy);
  const { data: allTypes } = useTypes();
  
  // Use controlled viewType if provided, otherwise use internal state
  const viewType = controlledViewType ?? internalViewType;
  const setViewType = setInternalViewType;
  
  // Build groups from items
  const groups = useMemo((): NodeSetGroup[] => {
    if (groupBy === 'none' || viewType !== 'list') {
      return [];
    }
    
    const groupsMap = new Map<string, NodeSetGroup>();
    
    for (const item of items) {
      let key: string;
      let label: string;
      let icon: ReactNode | undefined;
      
      if (groupBy === 'page') {
        const pageId = item.page?.id ?? item.node.page_id;
        if (pageId === null || pageId === undefined) {
          key = 'orphan';
          label = 'No page';
          icon = undefined;
        } else {
          key = `page-${pageId}`;
          const page = item.page ?? pageMap?.get(pageId);
          label = page?.name || 'Untitled';
          icon = page ? <NodeIcon icon={page.icon} isPage={true} size="sm" /> : undefined;
        }
      } else if (groupBy === 'type') {
        // Group by node type (page/block)
        key = item.node.is_page ? 'page' : 'block';
        label = item.node.is_page ? 'Pages' : 'Blocks';
        icon = undefined;
      } else if (groupBy === 'date') {
        // Group by creation date (day)
        const date = new Date(item.node.create_date);
        key = `date-${date.toISOString().split('T')[0]}`;
        label = date.toLocaleDateString(undefined, { dateStyle: 'medium' });
        icon = undefined;
      } else {
        continue;
      }
      
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          key,
          label,
          icon,
          items: [],
        });
      }
      groupsMap.get(key)!.items.push(item);
    }
    
    // Sort groups
    const sortedGroups = Array.from(groupsMap.values());
    sortedGroups.sort((a, b) => a.label.localeCompare(b.label));
    
    return sortedGroups;
  }, [items, groupBy, pageMap, viewType]);
  
  // Handle group click (navigate to page)
  const handleGroupClick = useCallback((groupKey: string) => {
    if (groupBy === 'page' && groupKey.startsWith('page-')) {
      const pageId = parseInt(groupKey.replace('page-', ''), 10);
      const page = pageMap?.get(pageId);
      if (page) {
        onNodeClick?.(page);
      }
    }
  }, [groupBy, pageMap, onNodeClick]);
  
  // Render the appropriate view
  const viewContent = useMemo(() => {
    if (items.length === 0) {
      if (!showEmpty) return null;
      return <p className="node-set__empty">{emptyMessage}</p>;
    }
    
    switch (viewType) {
      case 'list':
        // Use two-section list view (pages first, then blocks with breadcrumbs)
        // when groupBy is 'page' (the default)
        if (groupBy === 'page') {
          return (
            <NodeSetTwoSectionListView 
              items={items}
              allTypes={allTypes}
              onNodeClick={onNodeClick} 
              onNodeShiftClick={onNodeShiftClick}
              pageMap={pageMap}
              onContentChange={onContentChange}
            />
          );
        }
        if (groupBy !== 'none' && groups.length > 0) {
          return (
            <NodeSetGroupedListView 
              groups={groups}
              allTypes={allTypes}
              onNodeClick={onNodeClick} 
              onNodeShiftClick={onNodeShiftClick}
              onGroupClick={handleGroupClick}
              onContentChange={onContentChange}
            />
          );
        }
        return <NodeSetListView items={items} allTypes={allTypes} onNodeClick={onNodeClick} onNodeShiftClick={onNodeShiftClick} onContentChange={onContentChange} />;
      case 'table':
        return <NodeSetTableView items={items} allTypes={allTypes} onNodeClick={onNodeClick} onNodeShiftClick={onNodeShiftClick} />;
      case 'card':
        return <NodeSetCardView items={items} onNodeClick={onNodeClick} onNodeShiftClick={onNodeShiftClick} />;
    }
  }, [viewType, items, groups, groupBy, allTypes, onNodeClick, onNodeShiftClick, onContentChange, showEmpty, emptyMessage, handleGroupClick, pageMap]);
  
  if (items.length === 0 && !showEmpty) {
    return null;
  }
  
  return (
    <div className={`node-set ${className}`}>
      {showHeader && (
        <header className="node-set__header">
          <div className="node-set__header-left">
            {headerLeft}
            {title && (
              <h3 className="node-set__title">
                {titleIcon && <span className="node-set__title-icon">{titleIcon}</span>}
                {title}
                {items.length > 0 && <span className="node-set__count">({items.length})</span>}
              </h3>
            )}
          </div>
          
          <div className="node-set__header-center">
            {headerCenter}
          </div>
          
          <div className="node-set__header-right">
            {headerRightExtra}
            {showGroupBySettings && groupByOptions.length > 1 && (
              <ButtonWithPanel
                icon={mdiTune}
                size="sm"
                variant="ghost"
                tooltip="View settings"
                panelPosition="bottom"
                panelAlignment="end"
                panelWidth={200}
              >
                <GroupSettingsPanel
                  groupBy={groupBy}
                  onChange={setGroupBy}
                  options={groupByOptions}
                />
              </ButtonWithPanel>
            )}
            {showViewToggle && viewTypes.length > 1 && (
              <SelectionButton
                options={viewTypes.map((opt) => ({
                  value: opt,
                  icon: VIEW_TYPE_OPTIONS[opt].icon,
                  label: VIEW_TYPE_OPTIONS[opt].label,
                }))}
                value={viewType}
                onChange={(val) => setViewType(val as NodeSetViewType)}
                size="sm"
              />
            )}
          </div>
        </header>
      )}
      
      <div className="node-set__content">
        {viewContent}
      </div>
    </div>
  );
}

export default NodeSet;
