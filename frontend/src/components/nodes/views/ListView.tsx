/**
 * ListView — List/outline view using Lexical BlockEditor.
 *
 * Uses a SINGLE BlockEditor instance for performance.
 * Passes nodes directly - BlockEditor handles runtime sync internally.
 * 
 * Supports groupBy='page' to organize nodes under page headers.
 * Supports groupBy=<property-uuid> to group by a node property value.
 */
import { useState, useCallback, useMemo, useId } from 'react';
import type { Node } from '@/types';
import type { Property } from '@/types/api';
import type { NodeListViewProps } from '@/types/nodeCollection';
import { Bullet } from '../../blocks/Bullet';
import { NodeInline } from '../../blocks/NodeInline';
import { ChevronRightIcon, ChevronDownIcon } from '../../core/icons';
import { BlockEditor } from '@/editor/BlockEditor';
import { ListSortable } from '../../core/ListSortable';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { queueContentSave } from '@/hooks/useBlockPersist';
import { sortBySequence } from '@/utils/nodeSort';
import { getNodeByUuid } from '@/api/nodes';
import './ListView.css';

// ── Group type ───────────────────────────────────────────────────────────────

/** A group of nodes with either a page header or a property-value header */
interface NodeGroup {
  /** For page grouping: the page node */
  page?: Node | null;
  /** Label to display when there is no page (property grouping or unknown) */
  label?: string;
  nodes: Node[];
}

// ── Property grouping helpers ─────────────────────────────────────────────────

/**
 * Get a stable group key and display label for a raw property value.
 */
function getPropertyGroupLabel(property: Property, rawValue: unknown): string {
  if (rawValue === null || rawValue === undefined) return '(No value)';

  switch (property.type) {
    case 'boolean':
      return rawValue ? 'Yes' : 'No';

    case 'integer':
    case 'float':
      return String(rawValue);

    case 'selection': {
      // Value may be a number ID, an { id } object, or an array of those
      const resolveId = (v: unknown): number | null => {
        if (typeof v === 'number') return v;
        if (typeof v === 'object' && v !== null && 'id' in v) return (v as { id: number }).id;
        return null;
      };
      if (Array.isArray(rawValue)) {
        const names = rawValue
          .map(resolveId)
          .filter((id): id is number => id !== null)
          .map(id => property.options?.find(o => o.id === id)?.name ?? String(id));
        return names.length > 0 ? names.join(', ') : '(No value)';
      }
      const optId = resolveId(rawValue);
      if (optId === null) return String(rawValue);
      return property.options?.find(o => o.id === optId)?.name ?? String(optId);
    }

    case 'node':
    case 'date':
      // Values are node IDs; show numeric representation for now
      return Array.isArray(rawValue)
        ? rawValue.map(String).join(', ')
        : String(rawValue);

    default:
      return String(rawValue);
  }
}

/**
 * ListView - List/outline view using Lexical editor
 *
 * Simply passes nodes to BlockEditor - no manual runtime sync needed.
 * The readOnly prop on BlockEditor controls edit vs preview mode.
 */
export function ListView({
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
  onEnterAtRoot,
  pageId,
  pageUuid,
  className = '',
  groupBy = 'none',
  groupByProperty,
  enableGrouping = false,
}: NodeListViewProps) {
  const viewId = useId();

  // Collect all nodes recursively, filtering by pagesOnly if needed,
  // then sort by sequence (order field) so the editor receives them in
  // the correct display order.
  const allNodes = useMemo(() => {
    const result: Node[] = [];
    const collect = (n: Node) => {
      if (pagesOnly && !n.is_page) return;
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

  // Group nodes by page or property value when enableGrouping is true
  const groupedNodes = useMemo((): NodeGroup[] | null => {
    if (!enableGrouping || groupBy === 'none') {
      return null; // No grouping
    }

    if (groupBy === 'page') {
      // Group top-level nodes by their page
      const groups = new Map<string, NodeGroup>();
      
      for (const node of nodes) {
        const pageKey = (node as any).page_id 
          ? `page-${(node as any).page_id}` 
          : node.is_page 
            ? `self-${node.id}` 
            : 'no-page';
        
        if (!groups.has(pageKey)) {
          let pageNode: Node | null = null;
          if ((node as any).page_id) {
            pageNode = {
              id: (node as any).page_id,
              name: (node as any).page_name || 'Untitled',
              uuid: (node as any).page_uuid || '',
              is_page: true,
            } as Node;
          } else if (node.is_page) {
            pageNode = node;
          }
          
          groups.set(pageKey, { page: pageNode, nodes: [] });
        }
        
        groups.get(pageKey)!.nodes.push(node);
      }
      
      return Array.from(groups.values());
    }

    // Property-based grouping
    if (groupByProperty) {
      const propId = String(groupByProperty.id);
      const groups = new Map<string, NodeGroup>();
      
      for (const node of nodes) {
        const rawValue = (node.properties as Record<string, unknown> | undefined)?.[propId] ?? null;
        const label = getPropertyGroupLabel(groupByProperty, rawValue);
        
        if (!groups.has(label)) {
          groups.set(label, { label, nodes: [] });
        }
        groups.get(label)!.nodes.push(node);
      }
      
      return Array.from(groups.values());
    }

    return null;
  }, [nodes, groupBy, groupByProperty, enableGrouping]);

  // Grouped view (by page or property)
  if (groupedNodes) {
    return (
      <div className={`node-list-view node-list-view--grouped ${className}`}>
        {groupedNodes.map((group, groupIndex) => {
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
              groupKey={groupKey}
              sortedGroupNodes={sortedGroupNodes}
              viewId={viewId}
              editable={editable}
              handleNavigateToNode={handleNavigateToNode}
              handleOpenInSidebar={handleOpenInSidebar}
              handleContentChangeBridge={handleContentChangeBridge}
              onAddClass={onAddClass}
              onSlashCommand={onSlashCommand}
              onPasteImage={onPasteImage}
              onNodeClick={onNodeClick}
              onNodeShiftClick={onNodeShiftClick}
              pageId={pageId}
              pageUuid={pageUuid}
            />
          );
        })}
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
        className={`node-list-view node-list-view--sortable ${className}`}
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
      <div className={`node-list-view node-list-view--empty ${className}`}>
        <span className="node-list-view__empty-message">No items</span>
      </div>
    );
  }

  // BlockEditor handles runtime sync internally
  return (
    <div className={`node-list-view ${editable ? 'node-list-view--editable' : 'node-list-view--readonly'} ${className}`}>
      <BlockEditor
        editorId={`list-view-${viewId}`}
        nodes={allNodes}
        mode="list"
        readOnly={!editable}
        onNavigateToNode={handleNavigateToNode}
        onOpenInSidebar={handleOpenInSidebar}
        onContentChange={handleContentChangeBridge}
        onAddClass={onAddClass}
        onSlashCommand={onSlashCommand}
        onPasteImage={onPasteImage}
        pageId={pageId}
        pageUuid={pageUuid}
        className="node-list-view__editor"
        onEnterAtRoot={onEnterAtRoot}
      />
    </div>
  );
}

// ==================== ListViewGroup ====================

/**
 * A collapsible group within the grouped ListView.
 * Shows a page header with collapse arrow and dotted underline node-link style.
 */
function ListViewGroup({
  group,
  groupKey,
  sortedGroupNodes,
  viewId,
  editable,
  handleNavigateToNode,
  handleOpenInSidebar,
  handleContentChangeBridge,
  onAddClass,
  onSlashCommand,
  onPasteImage,
  onNodeClick,
  onNodeShiftClick,
  pageId,
  pageUuid,
}: {
  group: NodeGroup;
  groupKey: string;
  sortedGroupNodes: Node[];
  viewId: string;
  editable: boolean;
  handleNavigateToNode: (blockId: string) => Promise<void>;
  handleOpenInSidebar: (blockId: string) => void;
  handleContentChangeBridge: (blockId: string, content: string) => void;
  onAddClass?: (nodeId: number, classId: number) => void;
  onSlashCommand?: (commandId: string, blockServerId: number | undefined) => void;
  onPasteImage?: (blockServerId: number, file: File, hasContent: boolean) => void;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  pageId?: number;
  pageUuid?: string;
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
          ) : (
            <span className="node-list-view__group-label">{group.label}</span>
          )}
        </div>
      )}
      {!isCollapsed && (
        <div className="node-list-view__group-content">
          <BlockEditor
            editorId={`list-view-${viewId}-${groupKey}`}
            nodes={sortedGroupNodes}
            mode="list"
            readOnly={!editable}
            onNavigateToNode={handleNavigateToNode}
            onOpenInSidebar={handleOpenInSidebar}
            onContentChange={handleContentChangeBridge}
            onAddClass={onAddClass}
            onSlashCommand={onSlashCommand}
            onPasteImage={onPasteImage}
            pageId={pageId}
            pageUuid={pageUuid}
            className="node-list-view__editor"
          />
        </div>
      )}
    </div>
  );
}
