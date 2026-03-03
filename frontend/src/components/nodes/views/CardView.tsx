/**
 * CardView — Card grid container.
 *
 * CSS column-based masonry layout with:
 * - Card size variants (1–5 columns) driven by store
 * - Horizontal layout overrides (max 2 columns)
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
  useId,
  type JSX,
} from 'react';

import { NodeCard } from './CardItem';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { apiNodesToGraphNodes } from '@/hooks/useRuntimeSync';
import { useStructureSync } from '@/hooks/useStructureSync';
import { useBlockPersist } from '@/hooks/useBlockPersist';
import type { Node } from '@/types';
import type { Property } from '@/types/api';
import type { NodeCardViewProps } from '@/types/nodeCollection';
import { useClasses } from '@/hooks';
import { useAppStore } from '@/stores';
import { Button } from '@/components/core/Button';
import { Card } from '@/components/core/Card';
import { NodeIcon } from '@/components/core/icons';
import { mdiPlus } from '@mdi/js';
import { sortBySequence } from '@/utils/nodeSort';
import { nodeNameToText } from '@/hooks/useStringifyAST';

import './CardView.css';

// ── Group type ───────────────────────────────────────────────────────────────

interface CardGroup {
  page?: Node | null;
  label?: string;
  /** Icon for the group header (selection option icon) */
  headerIcon?: string | null;
  nodes: Node[];
}

// ── Property grouping helper ───────────────────────────────────────────────

function getPropertyGroupInfo(property: Property, rawValue: unknown): { label: string; icon: string | null } {
  if (rawValue === null || rawValue === undefined) return { label: '(No value)', icon: null };
  switch (property.type) {
    case 'boolean': return { label: rawValue ? 'Yes' : 'No', icon: null };
    case 'integer':
    case 'float': return { label: String(rawValue), icon: null };
    case 'selection': {
      const resolveId = (v: unknown): number | null => {
        if (typeof v === 'number') return v;
        if (typeof v === 'object' && v !== null && 'id' in v) return (v as { id: number }).id;
        return null;
      };
      if (Array.isArray(rawValue)) {
        const opts = rawValue
          .map(resolveId)
          .filter((id): id is number => id !== null)
          .map(id => property.options?.find(o => o.id === id));
        const names = opts.map(o => o?.name ?? '?').join(', ');
        const icon = opts.length === 1 ? (opts[0]?.icon ?? null) : null;
        return { label: names || '(No value)', icon };
      }
      const optId = resolveId(rawValue);
      if (optId === null) return { label: String(rawValue), icon: null };
      const opt = property.options?.find(o => o.id === optId);
      return { label: opt?.name ?? String(optId), icon: opt?.icon ?? null };
    }
    default: return { label: String(rawValue), icon: null };
  }
}

// ─── Component ────────────────────────────────────────────────────

export function CardView({
  nodes,
  layout = 'no-cover',
  columns,
  sortable,
  editable = true,
  selectable = false,
  selectedIds: controlledSelectedIds,
  onSelectionChange: controlledOnSelectionChange,
  onReorder,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  onAdd,
  customContextMenu,
  className = '',
  groupBy = 'none',
  groupByProperty,
}: NodeCardViewProps): JSX.Element {
  const viewId = useId();

  // ─── Sync structural changes to database ───────────────────
  useStructureSync();

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
  }, [nodes, viewId]);

  // Card size from store
  const cardSize = useAppStore(state => state.cardSize);

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
      const groups = new Map<string, CardGroup>();
      
      for (const node of sortedNodes) {
        const rawValue = (node.properties as Record<string, unknown> | undefined)?.[propId] ?? null;
        const { label, icon } = getPropertyGroupInfo(groupByProperty, rawValue);
        
        if (!groups.has(label)) {
          groups.set(label, { label, headerIcon: icon, nodes: [] });
        }
        groups.get(label)!.nodes.push(node);
      }
      
      return Array.from(groups.values());
    }

    return null;
  }, [sortedNodes, groupBy, groupByProperty]);

  const gridStyle = columns
    ? { gridTemplateColumns: `repeat(${columns}, 1fr)` }
    : undefined;

  // Fetch all classes for icon inheritance
  const { data: allClasses } = useClasses();

  // Internal selection state when selectable but not controlled
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<number>>(new Set());

  const selectedIds = selectable ? (controlledSelectedIds ?? internalSelectedIds) : undefined;
  const onSelectionChange = selectable ? (controlledOnSelectionChange ?? setInternalSelectedIds) : undefined;

  // Drag state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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
    setDragIndex(index);
  }, []);

  // Handle mouse move during drag
  useEffect(() => {
    if (dragIndex === null || !sortable) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;

      const cards = containerRef.current.querySelectorAll('.node-card');
      let newDropTarget: number | null = null;

      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
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
    `node-card-view--size-${cardSize}`,
    groupedNodes && 'node-card-view--kanban',
    className,
  ].filter(Boolean).join(' ');

  // Kanban view (grouped)
  if (groupedNodes) {
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
                    {group.page.icon && <span className="node-card-view__kanban-icon">{group.page.icon}</span>}
                    <span className="node-card-view__kanban-title">{nodeNameToText(group.page.name) || 'Untitled'}</span>
                    <span className="node-card-view__kanban-count">{group.nodes.length}</span>
                  </>
                ) : group.label !== undefined ? (
                  <>
                    {group.headerIcon && <NodeIcon icon={group.headerIcon} size="xs" className="node-card-view__kanban-icon" />}
                    <span className="node-card-view__kanban-title">{group.label}</span>
                    <span className="node-card-view__kanban-count">{group.nodes.length}</span>
                  </>
                ) : (
                  <span className="node-card-view__kanban-title">No Page</span>
                )}
              </div>
              <div className="node-card-view__kanban-cards">
                {group.nodes.map((node, index) => (
                  <NodeCard
                    key={node.id}
                    node={node}
                    index={index}
                    layout={layout}
                    sortable={false}
                    isDragging={false}
                    isDropTarget={false}
                    editable={editable}
                    allClasses={allClasses}
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
    <div className={gridClassName} style={gridStyle} ref={containerRef}>
      {sortedNodes.map((node, index) => (
        <NodeCard
          key={node.id}
          node={node}
          index={index}
          layout={layout}
          sortable={sortable}
          isDragging={dragIndex === index}
          isDropTarget={dropTargetIndex === index && dragIndex !== index}
          editable={editable}
          allClasses={allClasses}
          isSelected={selectable && selectedIds?.has(node.id)}
          onNodeClick={onNodeClick}
          onNodeShiftClick={onNodeShiftClick}
          onContentChange={onContentChange}
          onDragStart={handleDragStart}
          onSelectionChange={selectable ? handleCardSelectionChange : undefined}
          customContextMenu={customContextMenu}
        />
      ))}
      {editable && onAdd && (
        <Card
          className="node-card-add"
          padding={false}
          elevation="none"
          variant="default"
          onClick={onAdd}
        >
          <div className="node-card-add__content">
            <Button
              variant="ghost"
              size="lg"
              icon={mdiPlus}
              className="node-card-add__button"
              onClick={(e) => {
                e.stopPropagation();
                onAdd();
              }}
            >
              Add card
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
