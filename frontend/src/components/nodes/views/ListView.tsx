/**
 * ListView — List/outline view using BlockList.
 *
 * Passes nodes directly to BlockList for rendering.
 *
 * Supports groupBy='page' to organize nodes under page headers.
 * Supports groupBy=<property-uuid> to group by a node property value.
 */
import { useState, useCallback, useMemo, memo } from 'react';
import type { Node } from '@/types';
import type { NodeListViewProps } from '@/types/nodeCollection';
import { Bullet } from '../../blocks/Bullet';
import { NodeInline } from '../../blocks/NodeInline';
import { NodeIcon, ChevronRightIcon, ChevronDownIcon } from '../../core/icons';

import { BlockList } from '../../blocks/BlockList';
import { ListSortable } from '../../core/ListSortable';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { getPropertyGroupInfo } from './viewHelpers';
import { queueContentSave } from '@/hooks/useBlockPersist';
import { sortBySequence } from '@/utils/nodeSort';
import { getNodeByUuid } from '@/api/nodes';
import { NodeBreadcrumbs } from '../NodeBreadcrumbs';
import './ListView.css';
import { registerView } from './registry';
// ── Group type ───────────────────────────────────────────────────────────────

/** A group of nodes with either a page header or a property-value header */
interface NodeGroup {
  /** For page grouping: the page node */
  page?: Node | null;
  /** Label to display when there is no page (property grouping or unknown) */
  label?: string;
  /** Icon for the group header (selection/node property option icon) */
  headerIcon?: string | null;
  nodes: Node[];
}

/** Result of grouping: named groups + pages + ungrouped remainder */
interface GroupingResult {
  groups: NodeGroup[];
  pages: Node[];
  ungrouped: Node[];
}

// ── Property grouping helpers ─────────────────────────────────────────────────

/**
 * Get a stable group key, display label, and optional icon for a raw property value.
 */
/**
 * ListView - List/outline view using BlockList
 *
 * Simply passes nodes to BlockList - no manual runtime sync needed.
 * The readOnly prop on BlockList controls edit vs preview mode.
 */
export const ListView = memo(function ListView({
  nodes,
  editable,
  pagesOnly = false,
  sortable = false,
  onReorder,
  renderItemAction,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  onAddClass,
  onSlashCommand,
  onTemplateInstantiate,
  templateClassFilters,
  onEnterAtRoot: _onEnterAtRoot,
  pageUuid: _pageUuid,
  pageId: _pageId,
  className = '',
  groupBy = 'none',
  groupByProperty,
  enableGrouping = false,
  showBreadcrumbs = false,
  size,
  maxDepth,
}: NodeListViewProps) {
  const sizeClass = size === 'sm' ? 'node-list-view--sm' : '';

  // Collect all nodes recursively, filtering by pagesOnly if needed,
  // then sort by sequence (order field) so the editor receives them in
  // the correct display order.
  const allNodes = useMemo(() => {
    const result: Node[] = [];
    const collect = (n: Node) => {
      if (pagesOnly && !n.is_page) return;
      if (!pagesOnly && n.is_page) return;
      result.push(n);
      if (n.children) {
        for (const child of n.children) {
          collect(child);
        }
      }
    };
    for (const n of nodes) {
      collect(n);
    }
    return sortBySequence(result);
  }, [nodes, pagesOnly]);

  // Resolve alias: if node is an alias, return the main node instead
  const resolveAlias = useCallback((node: Node): Node => {
    if (node.aliased_id) {
      const mainNode = allNodes.find(n => n.id === node.aliased_id);
      return mainNode ?? { id: node.aliased_id, is_page: true } as Node;
    }
    return node;
  }, [allNodes]);

  // Handler for navigation from editor
  const handleNavigateToNode = useCallback(async (blockId: string) => {
    // Get runtime to resolve blockId to serverId
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    
    if (graphNode?.serverId) {
      const targetNode = allNodes.find(n => n.id === graphNode.serverId);
      if (targetNode) {
        onNodeClick?.(resolveAlias(targetNode));
      } else {
        onNodeClick?.({ id: graphNode.serverId, is_page: graphNode.isPage } as Node);
      }
      return;
    }

    // Node not in runtime — fetch by UUID from API
    try {
      const { parseLinkId } = await import('@/lib/astBuilder');
      const { nodeUuid } = parseLinkId(blockId);
      const node = await getNodeByUuid(nodeUuid);
      onNodeClick?.(resolveAlias(node));
    } catch {
      // Node not found
    }
  }, [allNodes, onNodeClick, resolveAlias]);

  // Handler for shift-click (open in sidebar) from editor
  const handleOpenInSidebar = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    if (graphNode?.serverId) {
      const targetNode = allNodes.find(n => n.id === graphNode.serverId);
      if (targetNode) {
        onNodeShiftClick?.(targetNode);
      } else {
        onNodeShiftClick?.({ id: graphNode.serverId, is_page: graphNode.isPage } as Node);
      }
      return;
    }
    // Fallback: UUID-based lookup
    const node = allNodes.find(n => n.uuid === blockId);
    if (node) {
      onNodeShiftClick?.(node);
    }
  }, [allNodes, onNodeShiftClick]);

  // Handler for content changes from editor
  const handleContentChangeBridge = useCallback((blockId: string, content: string) => {
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    const serverId = graphNode?.serverId;
    if (serverId != null) {
      onContentChange?.(serverId, content);
    } else if (graphNode) {
      // Block not yet persisted — queue for when serverId arrives
      queueContentSave(blockId, content);
    }
  }, [onContentChange]);

  // Group nodes by page or property value when enableGrouping is true.
  // Nodes that don't belong to any group (pages when grouping by page,
  // or nodes missing the property) are collected in `ungrouped`.
  const groupingResult = useMemo((): GroupingResult | null => {
    if (!enableGrouping || groupBy === 'none') {
      return null; // No grouping
    }

    if (groupBy === 'page') {
      // Group blocks by their containing page.
      // Pages themselves always go into the separate `pages` section.
      const groups = new Map<string, NodeGroup>();
      const pages: Node[] = [];
      const ungrouped: Node[] = [];
      
      for (const node of nodes) {
        if (node.is_page) {
          pages.push(node);
        } else if ((node as any).page_id) {
          const pageKey = `page-${(node as any).page_id}`;
          if (!groups.has(pageKey)) {
            const pageNode = {
              id: (node as any).page_id,
              name: (node as any).page_name || 'Untitled',
              uuid: (node as any).page_uuid || '',
              is_page: true,
            } as Node;
            groups.set(pageKey, { page: pageNode, nodes: [] });
          }
          groups.get(pageKey)!.nodes.push(node);
        } else {
          // Blocks without a page_id → ungrouped
          ungrouped.push(node);
        }
      }
      
      return { groups: Array.from(groups.values()), pages, ungrouped };
    }

    // Property-based grouping
    if (groupByProperty) {
      const propId = String(groupByProperty.id);
      const groups = new Map<string, NodeGroup>();
      const ungrouped: Node[] = [];
      
      for (const node of nodes) {
        const rawValue = (node.properties as Record<string, unknown> | undefined)?.[propId] ?? null;
        if (rawValue === null || rawValue === undefined) {
          ungrouped.push(node);
          continue;
        }
        const { label, icon } = getPropertyGroupInfo(groupByProperty, rawValue);
        
        if (!groups.has(label)) {
          groups.set(label, { label, headerIcon: icon, nodes: [] });
        }
        groups.get(label)!.nodes.push(node);
      }
      
      return { groups: Array.from(groups.values()), pages: [], ungrouped };
    }

    return null;
  }, [nodes, groupBy, groupByProperty, enableGrouping]);

  // Collect and sort nodes for pages section
  const pagesAllNodes = useMemo(() => {
    if (!groupingResult || groupingResult.pages.length === 0) return [];
    const result: Node[] = [];
    const collect = (n: Node) => {
      if (pagesOnly && !n.is_page) return;
      result.push(n);
      if (n.children) {
        for (const child of n.children) collect(child);
      }
    };
    for (const n of groupingResult.pages) collect(n);
    return sortBySequence(result);
  }, [groupingResult, pagesOnly]);

  // Collect and sort nodes for ungrouped section
  const ungroupedAllNodes = useMemo(() => {
    if (!groupingResult || groupingResult.ungrouped.length === 0) return [];
    const result: Node[] = [];
    const collect = (n: Node) => {
      if (pagesOnly && !n.is_page) return;
      result.push(n);
      if (n.children) {
        for (const child of n.children) collect(child);
      }
    };
    for (const n of groupingResult.ungrouped) collect(n);
    return sortBySequence(result);
  }, [groupingResult, pagesOnly]);

  // Grouped view (by page or property)
  if (groupingResult) {
    return (
      <div className={`node-list-view node-list-view--grouped ${sizeClass} ${className}`}>
        {/* Pages section — shown before grouped blocks */}
        {pagesAllNodes.length > 0 && (
          <div className="node-list-view__pages">
            <div className="node-list-view__pages-header">
              <span className="node-list-view__group-label">Pages</span>
            </div>
            <div className="node-list-view__pages-content">
              <BlockList
                nodes={pagesAllNodes}
                readOnly={!editable}
                onNavigateToNode={handleNavigateToNode}
                onOpenInSidebar={handleOpenInSidebar}
                onContentChange={handleContentChangeBridge}
                pageUuid={_pageUuid}
                pageId={_pageId}
                onAddClass={onAddClass}
                onSlashCommand={onSlashCommand}
                onTemplateInstantiate={onTemplateInstantiate}
                templateClassFilters={templateClassFilters}
                skipPages={false}
              />
            </div>
          </div>
        )}
        {groupingResult.groups.map((group, groupIndex) => {
          // Collect all nodes in this group (including children)
          const groupAllNodes: Node[] = [];
          const collectGroupNodes = (n: Node) => {
            if (pagesOnly && !n.is_page) return;
            groupAllNodes.push(n);
            if (n.children) {
              for (const child of n.children) {
                collectGroupNodes(child);
              }
            }
          };
          
          for (const n of group.nodes) {
            collectGroupNodes(n);
          }
          
          const sortedGroupNodes = sortBySequence(groupAllNodes);
          
          if (sortedGroupNodes.length === 0) return null;
          
          const groupKey = group.page?.id 
            ? `page-${group.page.id}` 
            : group.label
              ? `prop-${group.label}`
              : `group-${groupIndex}`;
          
          return (
            <ListViewGroup
              key={groupKey}
              group={group}
              sortedGroupNodes={sortedGroupNodes}
              editable={editable}
              handleNavigateToNode={handleNavigateToNode}
              handleOpenInSidebar={handleOpenInSidebar}
              handleContentChangeBridge={handleContentChangeBridge}
              onAddClass={onAddClass}
              onSlashCommand={onSlashCommand}
              onTemplateInstantiate={onTemplateInstantiate}
              templateClassFilters={templateClassFilters}
              onNodeClick={onNodeClick}
              onNodeShiftClick={onNodeShiftClick}
              showBreadcrumbs={showBreadcrumbs}
              pageUuid={_pageUuid}
              pageId={_pageId}
            />
          );
        })}
        {ungroupedAllNodes.length > 0 && (
          <div className="node-list-view__ungrouped">
            <div className="node-list-view__ungrouped-header">
              <span className="node-list-view__group-label">No {groupBy === 'page' ? 'page' : groupByProperty?.name ?? 'value'}</span>
            </div>
            <div className="node-list-view__ungrouped-content">
              <BlockList
                nodes={ungroupedAllNodes}
                readOnly={!editable}
                onNavigateToNode={handleNavigateToNode}
                onOpenInSidebar={handleOpenInSidebar}
                onContentChange={handleContentChangeBridge}
                pageUuid={_pageUuid}
                onAddClass={onAddClass}
                onSlashCommand={onSlashCommand}
                onTemplateInstantiate={onTemplateInstantiate}
                templateClassFilters={templateClassFilters}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // If sortable, use ListSortable wrapper (special mode for reordering)
  if (sortable && onReorder) {
    return (
      <ListSortable
        items={nodes.map(n => ({ id: n.id, node: n }))}
        onReorder={onReorder}
        onItemClick={(item) => onNodeClick?.(item.node)}
        className={`node-list-view node-list-view--sortable ${sizeClass} ${className}`}
        itemClassName="node-list-view__sortable-item"
        showDragHandle={true}
        renderIcon={(item) => (
          <Bullet
            nodeId={item.node.id}
            icon={item.node.icon}
            isPage={item.node.is_page}
            interactive={false}
            size="sm"
          />
        )}
        renderText={(item) => (
          <span className="node-list-view__item-name">
            {item.node.name || 'Untitled'}
          </span>
        )}
        renderAction={renderItemAction
          ? (item, index) => renderItemAction(item.node, index)
          : undefined
        }
      />
    );
  }

  // Early return if no nodes
  if (allNodes.length === 0) {
    return (
      <div className={`node-list-view node-list-view--empty ${sizeClass} ${className}`}>
        <span className="node-list-view__empty-message">No items</span>
      </div>
    );
  }

  // Non-grouped breadcrumb mode: show full NodeBreadcrumbs above each top-level node.
  if (showBreadcrumbs) {
    return (
      <div className={`node-list-view node-list-view--breadcrumbs ${sizeClass} ${editable ? 'node-list-view--editable' : 'node-list-view--readonly'} ${className}`}>
        {nodes.map((node) => {
          const nodeFlat: Node[] = [];
          const collect = (n: Node) => {
            if (pagesOnly && !n.is_page) return;
            nodeFlat.push(n);
            if (n.children) for (const child of n.children) collect(child);
          };
          collect(node);
          const sorted = sortBySequence(nodeFlat);
          if (sorted.length === 0) return null;
          return (
            <div key={node.id} className="node-list-view__breadcrumb-group">
              <NodeBreadcrumbs
                nodeId={node.id}
                nodeType={node.is_page ? 'page' : 'block'}
                onNavigate={(id) => onNodeClick?.({ id, is_page: true } as Node)}
                className="node-list-view__breadcrumb-header"
              />
              <BlockList
                nodes={sorted}
                readOnly={!editable}
                onNavigateToNode={handleNavigateToNode}
                onOpenInSidebar={handleOpenInSidebar}
                onContentChange={handleContentChangeBridge}
                pageUuid={_pageUuid}
                onAddClass={onAddClass}
                onSlashCommand={onSlashCommand}
                onTemplateInstantiate={onTemplateInstantiate}
                templateClassFilters={templateClassFilters}
              />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`node-list-view ${sizeClass} ${editable ? 'node-list-view--editable' : 'node-list-view--readonly'} ${className}`}>
      <BlockList
        nodes={nodes}
        readOnly={!editable}
        onContentChange={handleContentChangeBridge}
        onAddClass={onAddClass}
        onSlashCommand={onSlashCommand}
        onTemplateInstantiate={onTemplateInstantiate}
        templateClassFilters={templateClassFilters}
        onNavigateToNode={handleNavigateToNode}
        onOpenInSidebar={handleOpenInSidebar}
        onPillClick={handleNavigateToNode}
        pageUuid={_pageUuid}
        maxDepth={maxDepth}
        pagesOnly={pagesOnly}
        skipPages={!pagesOnly}
      />
    </div>
  );
});

registerView({
  id: 'list',
  label: 'List',
  icon: 'mdi mdi-format-list-bulleted',
  component: ListView,
  capabilities: { groupBy: true },
});

// ==================== ListViewGroup ====================

/**
 * A collapsible group within the grouped ListView.
 * Shows a page header with collapse arrow and dotted underline node-link style.
 */
function ListViewGroup({
  group,
  sortedGroupNodes,
  editable,
  handleNavigateToNode,
  handleOpenInSidebar,
  handleContentChangeBridge,
  onAddClass,
  onSlashCommand,
  onTemplateInstantiate,
  templateClassFilters,
  onNodeClick,
  onNodeShiftClick,
  showBreadcrumbs = false,
  pageUuid,
  pageId,
}: {
  group: NodeGroup;
  sortedGroupNodes: Node[];
  editable: boolean;
  handleNavigateToNode: (blockId: string) => Promise<void>;
  handleOpenInSidebar: (blockId: string) => void;
  handleContentChangeBridge: (blockId: string, content: string) => void;
  onAddClass?: (nodeId: number, classId: number) => void;
  onSlashCommand?: (commandId: string, blockServerId: number | undefined) => void;
  onTemplateInstantiate?: (templateNodeId: number, blockServerId: number | undefined) => void;
  templateClassFilters?: number[];
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  showBreadcrumbs?: boolean;
  pageUuid?: string;
  pageId?: number;
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  
  return (
    <div className={`node-list-view__group ${isCollapsed ? 'node-list-view__group--collapsed' : ''}`}>
      {(group.page || group.label !== undefined) && (
        <div className="node-list-view__group-header">
          <button
            type="button"
            className="node-list-view__group-collapse"
            onClick={() => setIsCollapsed(prev => !prev)}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? 'Expand group' : 'Collapse group'}
          >
            {isCollapsed ? <ChevronRightIcon size="xs" /> : <ChevronDownIcon size="xs" />}
          </button>
          {group.page ? (
            <span className="node-list-view__group-page">
              <NodeInline
                name={group.page.name}
                icon={group.page.icon}
                isPage={group.page.is_page}
                nodeId={group.page.id}
                showBullet={false}
                onClick={() => onNodeClick?.(group.page!)}
                onShiftClick={() => onNodeShiftClick?.(group.page!)}
                className="node-list-view__group-link"
              />
            </span>
          ) : (
            <span className="node-list-view__group-label">
              {group.headerIcon && <NodeIcon icon={group.headerIcon} size="xs" />}
              {group.label}
            </span>
          )}
        </div>
      )}
      {!isCollapsed && (
        <div className="node-list-view__group-content">
          {showBreadcrumbs ? (
            group.nodes.map((node) => {
              const nodeFlat: Node[] = [];
              const collect = (n: Node) => {
                nodeFlat.push(n);
                if (n.children) for (const child of n.children) collect(child);
              };
              collect(node);
              const sorted = sortBySequence(nodeFlat);
              if (sorted.length === 0) return null;
              return (
                <div key={node.id} className="node-list-view__breadcrumb-group">
                  <NodeBreadcrumbs
                    nodeId={node.id}
                    nodeType={node.is_page ? 'page' : 'block'}
                    onNavigate={(id) => onNodeClick?.({ id, is_page: true } as Node)}
                    stopAtPageLevel
                    className="node-list-view__block-breadcrumbs"
                  />
                  <BlockList
                    nodes={sorted}
                    readOnly={!editable}
                    onNavigateToNode={handleNavigateToNode}
                    onOpenInSidebar={handleOpenInSidebar}
                    onContentChange={handleContentChangeBridge}
                    pageUuid={pageUuid}
                    pageId={pageId}
                    onAddClass={onAddClass}
                    onSlashCommand={onSlashCommand}
                    onTemplateInstantiate={onTemplateInstantiate}
                    templateClassFilters={templateClassFilters}
                  />
                </div>
              );
            })
          ) : (
            <BlockList
              nodes={sortedGroupNodes}
              readOnly={!editable}
              onNavigateToNode={handleNavigateToNode}
              onOpenInSidebar={handleOpenInSidebar}
              onContentChange={handleContentChangeBridge}
              onAddClass={onAddClass}
              onSlashCommand={onSlashCommand}
              onTemplateInstantiate={onTemplateInstantiate}
              templateClassFilters={templateClassFilters}
              pageUuid={pageUuid}
            />
          )}
        </div>
      )}
    </div>
  );
}
