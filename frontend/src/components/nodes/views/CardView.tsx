/**
 * CardView — Card grid container.
 *
 * Adaptive CSS multi-column masonry layout.
 * - Column count determined by container width and card min-width (CSS)
 * - Sortable drag support
 * - Selectable checkboxes
 * - "Add card" button
 *
 * Each card is rendered by NodeCard (from CardItem.tsx).
 */

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  memo,
  type JSX,
} from 'react';

import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { apiNodesToGraphNodes } from '@/hooks/useRuntimeSync';
import { useStructureSync } from '@/hooks/useStructureSync';
import { useCollapsePersist } from '@/hooks/useCollapsePersist';
import { useBlockPersist } from '@/hooks/useBlockPersist';
import type { Node } from '@/types';
import type { NodeCardViewProps } from '@/types/nodeCollection';
import { useClasses, useNodes, useTags } from '@/hooks';
import { NodeCard } from './CardItem';
import { getPropertyGroupInfo } from './viewHelpers';
import { NodeIcon } from '@/components/core/icons';
import { sortBySequence } from '@/utils/nodeSort';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useInView } from '@/hooks/useInView';

import './CardView.css';

/** Lazy wrapper around NodeCard that only mounts the expensive BlockEditor when visible */
function LazyNodeCard(props: React.ComponentProps<typeof NodeCard>) {
  const { ref, inView } = useInView({ rootMargin: '200px', once: true });
  return (
    <div ref={ref} className="node-card-lazy-wrapper">
      {inView ? (
        <NodeCard {...props} />
      ) : (
        <div className="node-card-placeholder" style={{ minHeight: 120 }} />
      )}
    </div>
  );
}
import { registerView } from './registry';
// ── Group type ───────────────────────────────────────────────────────────────

interface CardGroup {
  page?: Node | null;
  label?: string;
  /** Icon for the group header (selection option icon) */
  headerIcon?: string | null;
  nodes: Node[];
}

// ── Group sorting helper ───────────────────────────────────────────────────

/** Move the "None" group to the end so informed values appear first. */
function sortGroupsNoneLast(groups: CardGroup[]): CardGroup[] {
  const noneIndex = groups.findIndex(g => g.label === 'None' && !g.page);
  if (noneIndex === -1) return groups;
  const noneGroup = groups[noneIndex];
  const others = groups.filter((_, i) => i !== noneIndex);
  return [...others, noneGroup];
}

// ─── Component ────────────────────────────────────────────────────

export const CardView = memo(function CardView({
  nodes,
  layout = 'no-cover',
  sortable,
  editable = true,
  selectable = false,
  selectedIds: controlledSelectedIds,
  onSelectionChange: controlledOnSelectionChange,
  onReorder,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  customContextMenu,
  className = '',
  groupBy = 'none',
  groupByProperty,
}: NodeCardViewProps): JSX.Element {
  // ─── Sync structural changes to database ───────────────────
  useStructureSync();

  // ─── Persist collapse state to database ─────────────────────
  useCollapsePersist();

  // ─── Persist new blocks to database ────────────────────────
  useBlockPersist();

  // ─── Sync nodes to runtime ──────────────────────────────────
  useMemo(() => {
    if (!nodes || nodes.length === 0) return;
    const allNodes: Node[] = [];
    const collect = (n: Node) => {
      allNodes.push(n);
      if (n.children) {
        for (const child of n.children) collect(child);
      }
    };
    for (const n of nodes) collect(n);

    const runtime = getNodeGraphRuntime();
    const { graphNodes } = apiNodesToGraphNodes(allNodes);
    runtime.upsertNodes(graphNodes);
  }, [nodes]);

  // Sort cards by sequence (order field)
  const sortedNodes = useMemo(() => sortBySequence(nodes), [nodes]);

  // Group nodes by page or property value
  const groupedNodes = useMemo((): CardGroup[] | null => {
    if (groupBy === 'none') {
      return null; // No grouping
    }

    if (groupBy === 'page') {
      const groups = new Map<string, CardGroup>();

      for (const node of sortedNodes) {
        const pageId = node.page_id;

        if (pageId) {
          const pageKey = `page-${pageId}`;
          if (!groups.has(pageKey)) {
            const pageNode = {
              id: pageId,
              name: node.page_name || 'Untitled',
              uuid: node.page_uuid || '',
              is_page: true,
            } as Node;
            groups.set(pageKey, { page: pageNode, nodes: [] });
          }
          groups.get(pageKey)!.nodes.push(node);
        } else {
          // Pages and blocks without a page_id → None group
          if (!groups.has('none')) {
            groups.set('none', { label: 'None', nodes: [] });
          }
          groups.get('none')!.nodes.push(node);
        }
      }

      return sortGroupsNoneLast(Array.from(groups.values()));
    }

    // Property-based grouping
    if (groupByProperty) {
      const propId = String(groupByProperty.id);
      const groups = new Map<string, CardGroup>();

      for (const node of sortedNodes) {
        const rawValue = (node.properties as Record<string, unknown> | undefined)?.[propId] ?? null;

        if (rawValue === null || rawValue === undefined) {
          if (!groups.has('none')) {
            groups.set('none', { label: 'None', nodes: [] });
          }
          groups.get('none')!.nodes.push(node);
        } else {
          const { label, icon } = getPropertyGroupInfo(groupByProperty, rawValue);
          if (!groups.has(label)) {
            groups.set(label, { label, headerIcon: icon, nodes: [] });
          }
          groups.get(label)!.nodes.push(node);
        }
      }

      return sortGroupsNoneLast(Array.from(groups.values()));
    }

    return null;
  }, [sortedNodes, groupBy, groupByProperty]);

  // Fetch all classes, nodes, and tags for icon/metadata resolution
  const { data: allClasses } = useClasses();
  const { data: allNodes } = useNodes();
  const { data: allTags } = useTags();

  // Internal selection state when selectable but not controlled
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<number>>(new Set());

  const selectedIds = selectable ? (controlledSelectedIds ?? internalSelectedIds) : undefined;
  const onSelectionChange = selectable ? (controlledOnSelectionChange ?? setInternalSelectedIds) : undefined;

  // Drag state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRectsRef = useRef<DOMRect[]>([]);

  // Handle selection change for individual card
  const handleCardSelectionChange = useCallback((nodeId: number, selected: boolean) => {
    if (!onSelectionChange) return;
    const newSelectedIds = new Set(selectedIds || []);
    if (selected) {
      newSelectedIds.add(nodeId);
    } else {
      newSelectedIds.delete(nodeId);
    }
    onSelectionChange(newSelectedIds);
  }, [selectedIds, onSelectionChange]);

  // Handle drag start
  const handleDragStart = useCallback((index: number) => {
    // Cache card positions at drag start to avoid layout thrashing on every mousemove
    if (containerRef.current) {
      cardRectsRef.current = Array.from(containerRef.current.querySelectorAll('.node-card')).map(
        (el) => el.getBoundingClientRect()
      );
    }
    setDragIndex(index);
  }, []);

  // Handle mouse move during drag
  useEffect(() => {
    if (dragIndex === null || !sortable) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rects = cardRectsRef.current;
      if (rects.length === 0) return;

      let newDropTarget: number | null = null;

      for (let i = 0; i < rects.length; i++) {
        const rect = rects[i];
        if (
          e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom
        ) {
          newDropTarget = i;
          break;
        }
      }

      setDropTargetIndex(newDropTarget);
    };

    const handleMouseUp = () => {
      if (dragIndex !== null && dropTargetIndex !== null && dragIndex !== dropTargetIndex) {
        onReorder?.(dragIndex, dropTargetIndex);
      }
      setDragIndex(null);
      setDropTargetIndex(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragIndex, dropTargetIndex, sortable, onReorder]);

  const gridClassName = [
    'node-card-view',
    sortable && 'node-card-view--sortable',
    selectable && 'node-card-view--selectable',
    layout === 'cover-top' && 'node-card-view--vertical-layout',
    groupedNodes && groupedNodes.length > 0 && 'node-card-view--kanban',
    className,
  ].filter(Boolean).join(' ');

  // Kanban view (grouped)
  if (groupedNodes && groupedNodes.length > 0) {
    return (
      <div className={gridClassName} ref={containerRef}>
        {groupedNodes.map((group, groupIndex) => {
          const groupKey = group.page?.id
            ? `page-${group.page.id}`
            : group.label !== undefined
              ? `prop-${group.label}`
              : `group-${groupIndex}`;

          return (
            <div key={groupKey} className="node-card-view__kanban-column">
              <div className="node-card-view__kanban-header">
                {group.page ? (
                  <>
                    {group.page.icon && <NodeIcon icon={group.page.icon} size="xs" className="node-card-view__kanban-icon" />}
                    <span className="node-card-view__kanban-title">{nodeNameToText(group.page.name) || 'Untitled'}</span>
                    <span className="node-card-view__kanban-count">{group.nodes.length}</span>
                  </>
                ) : (
                  <>
                    {group.headerIcon && <NodeIcon icon={group.headerIcon} size="xs" className="node-card-view__kanban-icon" />}
                    <span className="node-card-view__kanban-title">{group.label ?? 'None'}</span>
                    <span className="node-card-view__kanban-count">{group.nodes.length}</span>
                  </>
                )}
              </div>
              <div className="node-card-view__kanban-cards">
                {group.nodes.map((node, index) => (
                  <LazyNodeCard
                    key={node.id}
                    node={node}
                    index={index}
                    layout={layout}
                    sortable={false}
                    isDragging={false}
                    isDropTarget={false}
                    editable={editable}
                    allClasses={allClasses}
                    allNodes={allNodes}
                    allTags={allTags}
                    isSelected={selectable && selectedIds?.has(node.id)}
                    onNodeClick={onNodeClick}
                    onNodeShiftClick={onNodeShiftClick}
                    onContentChange={onContentChange}
                    onDragStart={handleDragStart}
                    onSelectionChange={selectable ? handleCardSelectionChange : undefined}
                    customContextMenu={customContextMenu}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Normal grid view
  return (
    <div className={gridClassName} ref={containerRef}>
      {sortedNodes.map((node, index) => (
        <LazyNodeCard
          key={node.id}
          node={node}
          index={index}
          layout={layout}
          sortable={sortable}
          isDragging={dragIndex === index}
          isDropTarget={dropTargetIndex === index && dragIndex !== index}
          editable={editable}
          allClasses={allClasses}
          allNodes={allNodes}
          allTags={allTags}
          isSelected={selectable && selectedIds?.has(node.id)}
          onNodeClick={onNodeClick}
          onNodeShiftClick={onNodeShiftClick}
          onContentChange={onContentChange}
          onDragStart={handleDragStart}
          onSelectionChange={selectable ? handleCardSelectionChange : undefined}
          customContextMenu={customContextMenu}
        />
      ))}

    </div>
  );
});

registerView({
  id: 'card',
  label: 'Cards',
  icon: 'mdi mdi-view-grid',
  component: CardView,
  capabilities: { groupBy: true, cardLayout: true, sorting: true },
});
