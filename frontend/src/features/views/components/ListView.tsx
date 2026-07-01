/**
 * ListView — List/outline view using BlockList.
 *
 * Passes nodes directly to BlockList for rendering.
 *
 * Supports single- and multi-level grouping:
 *  - 'page' groups blocks by their containing page (pages group by own id)
 *  - property UUIDs group by that property value
 *  - multiple levels build a recursive group tree
 */
import { useState, useCallback, useMemo, memo } from 'react';
import type { Node, Property } from '@/types';
import type { NodeListViewProps, NodeCollectionGroupBy } from '@/types/nodeCollection';
import { Bullet } from '@/features/content';
import { NodeInline } from '@/features/content';
import { NodeIcon, ChevronRightIcon, ChevronDownIcon } from '@/components/ui/icons';

import { BlockList } from '@/features/content';
import { ListSortable } from '@/components/ui/ListSortable';
import { useNodeCollectionContext, useClasses } from '@/features/content';
import { getEffectiveIcon } from '@/utils/nodeIcon';

import { getPropertyGroupInfo } from '../utils/viewHelpers';
import { sortBySequence, compareDateFirstAlpha } from '@/utils/nodeSort';
import { parseLinkId } from '@/lib/astBuilder';
import { NodeBreadcrumbs } from '@/features/content';
import './ListView.css';
import { registerView } from './registry';
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';


// ── Group types ───────────────────────────────────────────────────────────────

type GroupLevel = { kind: 'page' } | { kind: 'property'; property: Property };

interface GroupTreeNode {
  key: string;
  label: string;
  icon: string | null;
  page?: Node;
  children: GroupTreeNode[];
  nodes: Node[];
}

interface GroupingResult {
  pages: Node[];
  tree: GroupTreeNode[];
}

// ── Grouping helpers ──────────────────────────────────────────────────────────

function normalizeGroupByValue(value: NodeCollectionGroupBy): string[] {
  if (!value || value === 'none') return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function getPageGroupInfo(node: Node, allClasses?: Node[] | null): { key: string; label: string; icon: string | null; page: Node; missing: false } | { missing: true } {
  if (node.is_page) {
    return {
      missing: false,
      key: `page-${node.uuid}`,
      label: node.name || 'Untitled',
      icon: getEffectiveIcon(node, allClasses) ?? node.icon ?? null,
      page: node,
    };
  }

  const pageId = (node as { page_id?: number }).page_id;
  if (!pageId) return { missing: true };

  const pageName = (node as { page_name?: string }).page_name || 'Untitled';
  const pageIcon = (node as { page_icon?: string | null }).page_icon ?? null;

  return {
    missing: false,
    key: `page-${pageId}`,
    label: pageName,
    icon: pageIcon,
    page: {
      uuid: pageId,
      name: pageName,
      is_page: true,
      icon: pageIcon,
    } as unknown as Node,
  };
}

function getLevelGroupInfo(
  node: Node,
  level: GroupLevel,
  allClasses?: Node[] | null,
): { key: string; label: string; icon: string | null; page?: Node; missing: false } | { missing: true } {
  if (level.kind === 'page') {
    return getPageGroupInfo(node, allClasses);
  }

  const rawValue = (node.properties_uuid as Record<string, unknown> | undefined)?.[String(level.property.uuid)] ?? null;
  if (rawValue === null || rawValue === undefined) return { missing: true };

  const { label, icon } = getPropertyGroupInfo(level.property, rawValue);
  return { missing: false, key: `prop-${label}`, label, icon };
}

function sortGroups(groups: GroupTreeNode[], level: GroupLevel): GroupTreeNode[] {
  const sorted = [...groups];
  if (level.kind === 'page') {
    sorted.sort((a, b) => {
      if (a.page && b.page) return compareDateFirstAlpha(a.page, b.page);
      return 0;
    });
  } else {
    sorted.sort((a, b) => a.label.localeCompare(b.label));
  }
  return sorted;
}

function buildGroupTree(topNodes: Node[], levels: GroupLevel[], allClasses?: Node[] | null, parentKey = ''): GroupTreeNode[] {
  if (levels.length === 0) return [];

  const [level, ...rest] = levels;
  const groups = new Map<string, GroupTreeNode>();
  const noValue: Node[] = [];

  for (const node of topNodes) {
    const info = getLevelGroupInfo(node, level, allClasses);
    if (info.missing) {
      noValue.push(node);
      continue;
    }

    const { key, label, icon, page } = info;
    const fullKey = `${parentKey}/${key}`;
    if (!groups.has(fullKey)) {
      groups.set(fullKey, { key: fullKey, label, icon, page, children: [], nodes: [] });
    }
    groups.get(fullKey)!.nodes.push(node);
  }

  const result: GroupTreeNode[] = [];
  for (const group of sortGroups(Array.from(groups.values()), level)) {
    if (rest.length > 0) {
      group.children = buildGroupTree(group.nodes, rest, allClasses, group.key);
      group.nodes = [];
    }
    result.push(group);
  }

  if (noValue.length > 0) {
    const noValueKey = `${parentKey}/no-value`;
    const noValueLabel = level.kind === 'page' ? 'No page' : 'No value';
    const noValueGroup: GroupTreeNode = {
      key: noValueKey,
      label: noValueLabel,
      icon: null,
      children: [],
      nodes: [],
    };
    if (rest.length > 0) {
      noValueGroup.children = buildGroupTree(noValue, rest, allClasses, noValueKey);
    } else {
      noValueGroup.nodes = noValue;
    }
    result.push(noValueGroup);
  }

  return result;
}

// ── Component ─────────────────────────────────────────────────────────────────

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
  onPasteImage,
  onTemplateInstantiate,
  templateClassFilters,
  onEnterAtRoot: _onEnterAtRoot,
  nodeUuid: _nodeUuid,
  pageId: _pageId,
  className = '',
  groupBy = 'none',
  groupByProperty,
  groupByProperties,
  enableGrouping = false,
  showBreadcrumbs = false,
  size,
  maxDepth,
  showClasses = false,
  expandAll = false,
  showNewBlock = true,
  hideRootBullet = false,
  rootIsBlock = false,
}: NodeListViewProps) {
  const { inPropertyEditor } = useNodeCollectionContext();
  const sizeClass = size === 'sm' ? 'node-list-view--sm' : '';
  const { data: allClasses } = useClasses();

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

  // Effective icons for list items/group headers, resolving class inheritance.
  const effectiveIconMap = useMemo(() => {
    const map = new Map<string, string | null>();
    if (!allClasses) return map;
    for (const node of allNodes) {
      map.set(node.uuid, getEffectiveIcon(node, allClasses) ?? null);
    }
    return map;
  }, [allNodes, allClasses]);

  // Resolve alias: if node is an alias, return the main node instead
  const resolveAlias = useCallback((node: Node): Node => {
    if (node.aliased_uuid) {
      const mainNode = allNodes.find(n => n.uuid === node.aliased_uuid);
      return mainNode ?? { uuid: node.aliased_uuid, is_page: true } as unknown as Node;
    }
    return node;
  }, [allNodes]);

  // Handler for navigation from editor
  const handleNavigateToNode = useCallback((blockId: string) => {
    // Resolve to a target UUID synchronously. Use the runtime when available,
    // otherwise parse the link id. Avoiding an async fetch here eliminates the
    // stale-closure race where a later click could be overwritten by an earlier
    // fetch that finishes second.
    const runtime = getOperationRuntime();
    const graphNode = getNode(runtime, blockId);
    const nodeUuid = graphNode?.blockId ?? parseLinkId(blockId).nodeUuid;

    const targetNode = allNodes.find(n => n.uuid === nodeUuid);
    if (targetNode) {
      onNodeClick?.(resolveAlias(targetNode));
    } else {
      // Target is not in the loaded view; pass a minimal node so navigation can
      // still proceed. Alias redirection is only possible when the node is in
      // the local allNodes set.
      onNodeClick?.({ uuid: nodeUuid, is_page: true } as unknown as Node);
    }
  }, [allNodes, onNodeClick, resolveAlias]);

  // Handler for shift-click (open in sidebar) from editor
  const handleOpenInSidebar = useCallback((blockId: string) => {
    const runtime = getOperationRuntime();
    const graphNode = getNode(runtime, blockId);
    if (graphNode?.blockId) {
      const targetNode = allNodes.find(n => n.uuid === graphNode.blockId);
      if (targetNode) {
        onNodeShiftClick?.(targetNode);
      } else {
        onNodeShiftClick?.({ uuid: graphNode.blockId, is_page: graphNode.isPage } as unknown as Node);
      }
      return;
    }
    // Fallback: UUID-based lookup
    const node = allNodes.find(n => n.uuid === blockId);
    if (node) {
      onNodeShiftClick?.(node);
    }
  }, [allNodes, onNodeShiftClick]);

  // Handler for content changes from editor.
  // Pass the runtime block id (UUID) through; useContentSave resolves it to the
  // runtime node and creates an update_content operation even if the block has
  // not been persisted yet.
  const handleContentChangeBridge = useCallback((blockId: string, content: string) => {
    onContentChange?.(blockId, content);
  }, [onContentChange]);

  // Resolve grouping levels from groupBy and resolved property objects
  const levels = useMemo<GroupLevel[]>(() => {
    const normalized = normalizeGroupByValue(groupBy);
    const result: GroupLevel[] = [];
    for (const g of normalized) {
      if (g === 'page') {
        result.push({ kind: 'page' });
      } else {
        const prop = groupByProperties?.find(p => p.uuid === g) ??
          (groupByProperty?.uuid === g ? groupByProperty : undefined);
        if (prop) result.push({ kind: 'property', property: prop });
      }
    }
    return result;
  }, [groupBy, groupByProperties, groupByProperty]);

  // Build recursive group tree when grouping is enabled.
  // If the first level is 'page', pages are extracted to a dedicated Pages
  // section and the tree is built from the remaining non-page nodes.
  const groupingResult = useMemo((): GroupingResult | null => {
    if (!enableGrouping || levels.length === 0) return null;

    const pages: Node[] = [];
    let treeNodes = nodes;
    if (levels[0].kind === 'page') {
      for (const n of nodes) {
        if (n.is_page) pages.push(n);
      }
      treeNodes = nodes.filter(n => !n.is_page);
    }

    return { pages, tree: buildGroupTree(treeNodes, levels, allClasses) };
  }, [nodes, levels, enableGrouping, allClasses]);

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

  // Grouped view (by page and/or property, recursively)
  if (groupingResult) {
    return (
      <div className={`node-list-view node-list-view--grouped ${sizeClass} ${className}`} data-property-editor={inPropertyEditor || undefined}>
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
                nodeUuid={_nodeUuid}
                onAddClass={onAddClass}
                onSlashCommand={onSlashCommand}
                onPasteImage={onPasteImage}
                onTemplateInstantiate={onTemplateInstantiate}
                templateClassFilters={templateClassFilters}
                showClasses={showClasses}
                skipPages={false}
                expandAll={expandAll}
                listSize={size === 'sm' ? 'sm' : undefined}
                inPropertyEditor={inPropertyEditor}
                showNewBlock={showNewBlock}
                hideRootBullet={hideRootBullet}
                rootIsBlock={rootIsBlock}
              />
            </div>
          </div>
        )}

        {groupingResult.tree.map(group => (
          <ListViewGroup
            key={group.key}
            group={group}
            editable={editable}
            pagesOnly={pagesOnly}
            handleNavigateToNode={handleNavigateToNode}
            handleOpenInSidebar={handleOpenInSidebar}
            handleContentChangeBridge={handleContentChangeBridge}
            onAddClass={onAddClass}
            onSlashCommand={onSlashCommand}
            onPasteImage={onPasteImage}
            onTemplateInstantiate={onTemplateInstantiate}
            templateClassFilters={templateClassFilters}
            onNodeClick={onNodeClick}
            onNodeShiftClick={onNodeShiftClick}
            showBreadcrumbs={showBreadcrumbs}
            nodeUuid={_nodeUuid}
            showClasses={showClasses}
            expandAll={expandAll}
            inPropertyEditor={inPropertyEditor}
            showNewBlock={showNewBlock}
            hideRootBullet={hideRootBullet}
            rootIsBlock={rootIsBlock}
            size={size}
          />
        ))}
      </div>
    );
  }

  // If sortable, use ListSortable wrapper (special mode for reordering)
  if (sortable && onReorder) {
    return (
      <ListSortable
        items={nodes.map(n => ({ id: n.uuid, node: n }))}
        onReorder={onReorder}
        onItemClick={(item) => onNodeClick?.(item.node)}
        className={`node-list-view node-list-view--sortable ${sizeClass} ${className}`}
        itemClassName="node-list-view__sortable-item"
        showDragHandle={true}
        renderIcon={(item) => (
          <Bullet
            nodeUuid={item.node.uuid}
            icon={effectiveIconMap.get(item.node.uuid) ?? item.node.icon}
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

  // Non-grouped breadcrumb mode: show full NodeBreadcrumbs above each top-level node.
  if (showBreadcrumbs) {
    return (
      <div className={`node-list-view node-list-view--breadcrumbs ${sizeClass} ${editable ? 'node-list-view--editable' : 'node-list-view--readonly'} ${className}`} data-property-editor={inPropertyEditor || undefined}>
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
            <div key={node.uuid} className="node-list-view__breadcrumb-group">
              <NodeBreadcrumbs
                nodeUuid={node.uuid}
                nodeType={node.is_page ? 'page' : 'block'}
                onNavigate={(id) => onNodeClick?.({ uuid: id, is_page: true } as unknown as Node)}
                compact
                listView
                className="node-list-view__breadcrumb-header"
              />
              <BlockList
                nodes={sorted}
                readOnly={!editable}
                onNavigateToNode={handleNavigateToNode}
                onOpenInSidebar={handleOpenInSidebar}
                onContentChange={handleContentChangeBridge}
                nodeUuid={_nodeUuid}
                onAddClass={onAddClass}
                onSlashCommand={onSlashCommand}
                onPasteImage={onPasteImage}
                onTemplateInstantiate={onTemplateInstantiate}
                templateClassFilters={templateClassFilters}
                showClasses={showClasses}
                expandAll={expandAll}
                listSize={size === 'sm' ? 'sm' : undefined}
                inPropertyEditor={inPropertyEditor}
                showNewBlock={showNewBlock}
                hideRootBullet={hideRootBullet}
                rootIsBlock={rootIsBlock}
              />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`node-list-view ${sizeClass} ${editable ? 'node-list-view--editable' : 'node-list-view--readonly'} ${className}`} data-property-editor={inPropertyEditor || undefined}>
      <BlockList
        nodes={nodes}
        readOnly={!editable}
        onContentChange={handleContentChangeBridge}
        onAddClass={onAddClass}
        onSlashCommand={onSlashCommand}
        onPasteImage={onPasteImage}
        onTemplateInstantiate={onTemplateInstantiate}
        templateClassFilters={templateClassFilters}
        onNavigateToNode={handleNavigateToNode}
        onOpenInSidebar={handleOpenInSidebar}
        onPillClick={handleNavigateToNode}
        nodeUuid={_nodeUuid}
        maxDepth={maxDepth}
        pagesOnly={pagesOnly}
        skipPages={!pagesOnly}
        showClasses={showClasses}
        expandAll={expandAll}
        listSize={size === 'sm' ? 'sm' : undefined}
        inPropertyEditor={inPropertyEditor}
        showNewBlock={showNewBlock}
        hideRootBullet={hideRootBullet}
        rootIsBlock={rootIsBlock}
      />
    </div>
  );
});

registerView({
  id: 'list',
  label: 'List',
  icon: 'mdi mdi-format-list-bulleted',
  component: ListView,
  capabilities: { groupBy: true, sorting: true },
});

// ==================== ListViewGroup ====================

/**
 * A collapsible group within the grouped ListView.
 * Renders either nested child groups (intermediate levels) or a BlockList
 * of leaf nodes. Each group manages its own collapsed state.
 */
function ListViewGroup({
      group,
      editable,
      pagesOnly = false,
      handleNavigateToNode,
      handleOpenInSidebar,
      handleContentChangeBridge,
      onAddClass,
      onSlashCommand,
      onPasteImage,
      onTemplateInstantiate,
      templateClassFilters,
      onNodeClick,
      onNodeShiftClick,
      showBreadcrumbs = false,
      nodeUuid,
      showClasses = false,
      expandAll = false,
      inPropertyEditor = false,
      showNewBlock = true,
      hideRootBullet = false,
      rootIsBlock = false,
      size }: {
  group: GroupTreeNode;
  editable: boolean;
  pagesOnly?: boolean;
  handleNavigateToNode: (blockId: string) => void;
  handleOpenInSidebar: (blockId: string) => void;
  handleContentChangeBridge: (blockId: string, content: string) => void;
  onAddClass?: (nodeUuid: string, classId: string) => void;
  onSlashCommand?: (commandId: string, blockServerId: string | undefined) => void;
  onPasteImage?: (blockServerId: string, file: File, hasContent: boolean) => void;
  onTemplateInstantiate?: (templateNodeId: string, blockServerId: string | undefined) => void;
  templateClassFilters?: string[];
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  showBreadcrumbs?: boolean;
  nodeUuid?: string;
  showClasses?: boolean;
  expandAll?: boolean;
  inPropertyEditor?: boolean;
  showNewBlock?: boolean;
  hideRootBullet?: boolean;
  rootIsBlock?: boolean;
  size?: 'sm' | 'md';
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const isLeaf = group.children.length === 0;

  const leafNodes = useMemo(() => {
    const result: Node[] = [];
    const collect = (n: Node) => {
      if (pagesOnly && !n.is_page) return;
      result.push(n);
      if (n.children) {
        for (const child of n.children) collect(child);
      }
    };
    for (const n of group.nodes) collect(n);
    return sortBySequence(result);
  }, [group.nodes, pagesOnly]);

  return (
    <div className={`node-list-view__group ${isCollapsed ? 'node-list-view__group--collapsed' : ''}`}>
      <div className="node-list-view__group-header">
        <button
          type="button"
          className="node-list-view__group-collapse icon-only-touch-target"
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
              nodeUuid={group.page.uuid}
              showBullet={false}
              onClick={() => onNodeClick?.(group.page!)}
              onShiftClick={() => onNodeShiftClick?.(group.page!)}
              className="node-list-view__group-link"
              variant="group-link"
            />
          </span>
        ) : (
          <span className="node-list-view__group-label">
            {group.icon && <NodeIcon icon={group.icon} size="xs" />}
            {group.label}
          </span>
        )}
      </div>
      {!isCollapsed && (
        <div className="node-list-view__group-content">
          {isLeaf ? (
            showBreadcrumbs ? (
              group.nodes.map((node) => {
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
                  <div key={node.uuid} className="node-list-view__breadcrumb-group">
                    <NodeBreadcrumbs
                      nodeUuid={node.uuid}
                      nodeType={node.is_page ? 'page' : 'block'}
                      onNavigate={(id) => onNodeClick?.({ uuid: id, is_page: true } as unknown as Node)}
                      stopAtPageLevel
                      compact
                      listView
                      className="node-list-view__block-breadcrumbs"
                    />
                    <BlockList
                      nodes={sorted}
                      readOnly={!editable}
                      onNavigateToNode={handleNavigateToNode}
                      onOpenInSidebar={handleOpenInSidebar}
                      onContentChange={handleContentChangeBridge}
                      nodeUuid={nodeUuid}
                      onAddClass={onAddClass}
                      onSlashCommand={onSlashCommand}
                      onPasteImage={onPasteImage}
                      onTemplateInstantiate={onTemplateInstantiate}
                      templateClassFilters={templateClassFilters}
                      showClasses={showClasses}
                      expandAll={expandAll}
                      listSize={size === 'sm' ? 'sm' : undefined}
                      inPropertyEditor={inPropertyEditor}
                      showNewBlock={showNewBlock}
                      hideRootBullet={hideRootBullet}
                      rootIsBlock={rootIsBlock}
                    />
                  </div>
                );
              })
            ) : (
              <BlockList
                nodes={leafNodes}
                readOnly={!editable}
                onNavigateToNode={handleNavigateToNode}
                onOpenInSidebar={handleOpenInSidebar}
                onContentChange={handleContentChangeBridge}
                onAddClass={onAddClass}
                onSlashCommand={onSlashCommand}
                onPasteImage={onPasteImage}
                onTemplateInstantiate={onTemplateInstantiate}
                templateClassFilters={templateClassFilters}
                showClasses={showClasses}
                nodeUuid={nodeUuid}
                expandAll={expandAll}
                listSize={size === 'sm' ? 'sm' : undefined}
                inPropertyEditor={inPropertyEditor}
                showNewBlock={showNewBlock}
                hideRootBullet={hideRootBullet}
                rootIsBlock={rootIsBlock}
              />
            )
          ) : (
            group.children.map(child => (
              <ListViewGroup
                key={child.key}
                group={child}
                editable={editable}
                pagesOnly={pagesOnly}
                handleNavigateToNode={handleNavigateToNode}
                handleOpenInSidebar={handleOpenInSidebar}
                handleContentChangeBridge={handleContentChangeBridge}
                onAddClass={onAddClass}
                onSlashCommand={onSlashCommand}
                onPasteImage={onPasteImage}
                onTemplateInstantiate={onTemplateInstantiate}
                templateClassFilters={templateClassFilters}
                onNodeClick={onNodeClick}
                onNodeShiftClick={onNodeShiftClick}
                showBreadcrumbs={showBreadcrumbs}
                nodeUuid={nodeUuid}
                showClasses={showClasses}
                expandAll={expandAll}
                inPropertyEditor={inPropertyEditor}
                showNewBlock={showNewBlock}
                hideRootBullet={hideRootBullet}
                rootIsBlock={rootIsBlock}
                size={size}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
