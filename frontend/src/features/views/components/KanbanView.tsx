/**
 * KanbanView — Card grid container.
 *
 * Adaptive CSS multi-column masonry layout when ungrouped.
 * When grouped by a property, renders as a horizontal kanban board with
 * drag-and-drop between columns that mutates the property value.
 *
 * Each card is rendered by NodeCard (from KanbanCard.tsx).
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

import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
  useDraggable,
  useDroppable,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';

import { apiNodesToGraphNodes } from '@/features/content';
import { useCollapsePersist } from '@/features/content';
import type { Node } from '@/types';
import type { NodeKanbanViewProps } from '@/types/nodeCollection';

import { useClasses, useNodes, useTags } from '@/features/content';
import { useSetNodeProperty } from '@/features/properties';
import { NodeCard } from './KanbanCard';
import { getPropertyGroupInfo } from '../utils/viewHelpers';
import { NodeIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { sortBySequence } from '@/utils/nodeSort';
import { useInView } from '@/hooks/useInView';

import './KanbanView.css';

import { registerView } from './registry';
import { upsertNodes } from '@/runtime/eventBus';


/** Lazy wrapper around NodeCard that only mounts the expensive BlockEditor when visible */
function LazyNodeCard(props: React.ComponentProps<typeof NodeCard>) {
  const { ref, inView } = useInView({ rootMargin: '200px', once: true });
  return (
    <div ref={ref} className="node-card-lazy-wrapper">
      {inView ? (
        <NodeCard {...props} />
      ) : (
        <div className="node-card-placeholder" />
      )}
    </div>
  );
}

// ── Types ────────────────────────────────────────────────────────────────────

interface PropertyColumnData {
  id: string;
  label: string;
  icon: string | null;
  nodes: Node[];
  value: unknown;
}

// ── Draggable Card (grouped mode) ────────────────────────────────────────────

interface KanbanCardProps {
  node: Node;
  editable: boolean;
  layout: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right';
  allClasses?: Node[];
  allNodes?: Node[];
  allTags?: Node[];
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onContentChange?: (nodeId: number | string, content: string) => void;
  customContextMenu?: React.ComponentType<{
    node: Node;
    position: { x: number; y: number };
    onClose: () => void;
  }>;
  showBreadcrumbs?: boolean;
  context?: 'masonry' | 'kanban';
}

function KanbanCard({
  node,
  editable,
  layout,
  allClasses,
  allNodes,
  allTags,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  customContextMenu,
  showBreadcrumbs,
  context = 'masonry',
}: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `card-dnd-${node.id}`,
    data: { type: 'card', nodeId: node.id },
  });

  return (
    <div
      ref={setNodeRef}
      className={`node-kanban-view__kanban-card ${isDragging ? 'node-kanban-view__kanban-card--dragging' : ''}`}
      {...attributes}
      {...listeners}
    >
      <LazyNodeCard
        node={node}
        index={0}
        layout={layout}
        sortable={false}
        isDragging={isDragging}
        isDropTarget={false}
        editable={editable}
        allClasses={allClasses}
        allNodes={allNodes}
        allTags={allTags}
        onNodeClick={onNodeClick}
        onNodeShiftClick={onNodeShiftClick}
        onContentChange={onContentChange}
        customContextMenu={customContextMenu}
        showBreadcrumbs={showBreadcrumbs}
        context={context}
      />
    </div>
  );
}

// ── Droppable Column (grouped mode) ──────────────────────────────────────────

interface KanbanColumnProps {
  column: PropertyColumnData;
  editable: boolean;
  layout: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right';
  allClasses?: Node[];
  allNodes?: Node[];
  allTags?: Node[];
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onContentChange?: (nodeId: number | string, content: string) => void;
  customContextMenu?: React.ComponentType<{
    node: Node;
    position: { x: number; y: number };
    onClose: () => void;
  }>;
  collapsed: boolean;
  onToggleCollapse: () => void;
  showBreadcrumbs?: boolean;
}

function KanbanColumn({
  column,
  editable,
  layout,
  allClasses,
  allNodes,
  allTags,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  customContextMenu,
  collapsed,
  onToggleCollapse,
  showBreadcrumbs,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `card-column-${column.id}`,
    data: { type: 'column', columnId: column.id, value: column.value },
  });

  return (
    <div
      ref={setNodeRef}
      className={`node-kanban-view__kanban-column ${isOver ? 'node-kanban-view__kanban-column--over' : ''} ${collapsed ? 'node-kanban-view__kanban-column--collapsed' : ''}`}
      data-column-id={column.id}
    >
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- Pointer-only column header toggle; keyboard users can use the visible expand/collapse button inside it. */}
      <div
        className="node-kanban-view__kanban-header"
        onClick={onToggleCollapse}
      >
        {column.icon && <NodeIcon icon={column.icon} size="xs" className="node-kanban-view__kanban-icon" />}
        <span className="node-kanban-view__kanban-title">{column.label}</span>
        <span className="node-kanban-view__kanban-count">{column.nodes.length}</span>
        <Button
          icon={collapsed ? 'mdi mdi-chevron-right' : 'mdi mdi-chevron-down'}
          variant="ghost"
          size="xs"
          aria-label={collapsed ? 'Expand column' : 'Collapse column'}
          className="node-kanban-view__kanban-collapse-btn hover-reveal"
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
        />
      </div>

      {!collapsed && (
        <div className="node-kanban-view__kanban-cards">
          {column.nodes.map((node) => (
            <KanbanCard
              key={node.id}
              node={node}
              editable={editable}
              layout={layout}
              allClasses={allClasses}
              allNodes={allNodes}
              allTags={allTags}
              onNodeClick={onNodeClick}
              onNodeShiftClick={onNodeShiftClick}
              onContentChange={onContentChange}
              customContextMenu={customContextMenu}
              showBreadcrumbs={showBreadcrumbs}
              context="kanban"
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────

export const KanbanView = memo(function KanbanView({
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
  groupBy: _groupBy,
  groupByProperty,
  showBreadcrumbs = false,
}: NodeKanbanViewProps): JSX.Element {
  // ─── Persist collapse state to database ─────────────────────
  useCollapsePersist();

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

    const { graphNodes } = apiNodesToGraphNodes(allNodes);
    upsertNodes(graphNodes);
  }, [nodes]);

  // Sort cards by sequence (order field)
  const sortedNodes = useMemo(() => sortBySequence(nodes), [nodes]);

  // ─── Build property columns (grouped kanban mode) ──────────
  const propertyColumns = useMemo((): PropertyColumnData[] | null => {
    if (!groupByProperty) {
      return null;
    }

    const propId = String(groupByProperty.id);
    const valueMap = new Map<string, PropertyColumnData>();

    // Seed columns from property options (for selection properties)
    if (groupByProperty.type === 'selection' && groupByProperty.options) {
      for (const opt of groupByProperty.options) {
        const key = `opt-${opt.id}`;
        valueMap.set(key, {
          id: key,
          label: opt.name,
          icon: opt.icon ?? null,
          nodes: [],
          value: opt.id,
        });
      }
    }

    // Distribute nodes into columns
    for (const node of sortedNodes) {
      const rawValue = (node.properties as Record<string, unknown> | undefined)?.[propId] ?? null;

      if (rawValue === null || rawValue === undefined) {
        if (!valueMap.has('none')) {
          valueMap.set('none', { id: 'none', label: 'None', icon: null, nodes: [], value: null });
        }
        valueMap.get('none')!.nodes.push(node);
      } else {
        const { label, icon } = getPropertyGroupInfo(groupByProperty, rawValue);
        let key: string;
        if (typeof rawValue === 'number') {
          key = `opt-${rawValue}`;
        } else if (typeof rawValue === 'object' && rawValue !== null && 'id' in rawValue) {
          key = `opt-${(rawValue as { id: number }).id}`;
        } else {
          key = `val-${label}`;
        }

        if (!valueMap.has(key)) {
          valueMap.set(key, { id: key, label, icon, nodes: [], value: rawValue });
        }
        valueMap.get(key)!.nodes.push(node);
      }
    }

    // Sort columns: None first, then option-defined ones (by option sequence), then discovered ones
    const sorted = Array.from(valueMap.values());
    sorted.sort((a, b) => {
      const aIsNone = a.id === 'none' ? -1 : 0;
      const bIsNone = b.id === 'none' ? -1 : 0;
      if (aIsNone !== bIsNone) return aIsNone - bIsNone;

      if (groupByProperty.type === 'selection' && groupByProperty.options) {
        const aOpt = groupByProperty.options.find((o: { id: string | number; sequence?: number }) => `opt-${o.id}` === a.id);
        const bOpt = groupByProperty.options.find((o: { id: string | number; sequence?: number }) => `opt-${o.id}` === b.id);
        if (aOpt && bOpt) return (aOpt.sequence ?? 0) - (bOpt.sequence ?? 0);
      }

      return a.label.localeCompare(b.label);
    });

    return sorted.map((col) => ({ ...col, nodes: sortBySequence(col.nodes) }));
  }, [sortedNodes, groupByProperty]);

  // Fetch all classes, nodes, and tags for icon/metadata resolution
  const { data: allClasses } = useClasses();
  const { data: allNodes } = useNodes();
  const { data: allTags } = useTags();

  // Internal selection state when selectable but not controlled
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<number>>(new Set());

  const selectedIds = selectable ? (controlledSelectedIds ?? internalSelectedIds) : undefined;
  const onSelectionChange = selectable ? (controlledOnSelectionChange ?? setInternalSelectedIds) : undefined;

  // ─── Reorder drag state (ungrouped only) ────────────────────
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

  // Handle drag start (reorder)
  const handleDragStart = useCallback((index: number) => {
    if (containerRef.current) {
      cardRectsRef.current = Array.from(containerRef.current.querySelectorAll('.node-card')).map(
        (el) => el.getBoundingClientRect()
      );
    }
    setDragIndex(index);
  }, []);

  // Handle mouse move during drag (reorder)
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

  // ─── Kanban DnD state (grouped only) ────────────────────────
  const setNodeProperty = useSetNodeProperty();
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(new Set());
  const [dndActiveId, setDndActiveId] = useState<string | null>(null);

  const dndActiveNode = useMemo(() => {
    if (!dndActiveId) return null;
    const nodeId = Number(dndActiveId.replace('card-dnd-', ''));
    return nodes.find((n: Node) => n.id === nodeId) ?? null;
  }, [dndActiveId, nodes]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const toggleColumn = useCallback((columnId: string) => {
    setCollapsedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(columnId)) next.delete(columnId);
      else next.add(columnId);
      return next;
    });
  }, []);

  const handleDndDragStart = useCallback((event: DragStartEvent) => {
    setDndActiveId(String(event.active.id));
  }, []);

  const handleDndDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setDndActiveId(null);
    if (!over || !active.data.current) return;

    const activeNodeUuid = Number(String(active.id).replace('card-dnd-', ''));
    const overData = over.data.current as { type?: string; columnId?: string; value?: unknown } | undefined;

    if (!overData || overData.type !== 'column') return;

    const targetColumn = propertyColumns?.find((c) => c.id === overData.columnId);
    if (!targetColumn || !groupByProperty) return;

    const activeNodeData = active.data.current as { type?: string; nodeId?: number } | undefined;
    const sourceColumn = propertyColumns?.find((c) => c.nodes.some((n) => n.id === activeNodeData?.nodeId));
    if (sourceColumn && sourceColumn.id === targetColumn.id) return;

    const newValue = targetColumn.value;
    setNodeProperty.mutate({
      nodeId: activeNodeUuid,
      propertyId: groupByProperty.id,
      value: newValue,
    });
  }, [propertyColumns, groupByProperty, setNodeProperty]);

  const gridClassName = [
    'node-kanban-view',
    sortable && 'node-kanban-view--sortable',
    selectable && 'node-kanban-view--selectable',
    layout === 'cover-top' && 'node-kanban-view--vertical-layout',
    propertyColumns && propertyColumns.length > 0 && 'node-kanban-view--kanban',
    className,
  ].filter(Boolean).join(' ');

  // ─── Property-grouped kanban view ────────────────────────────
  if (propertyColumns && propertyColumns.length > 0) {
    return (
      <DndContext
        sensors={sensors}
        onDragStart={handleDndDragStart}
        onDragEnd={handleDndDragEnd}
      >
        <div className={gridClassName}>
          {propertyColumns.map((column) => (
            <KanbanColumn
              key={column.id}
              column={column}
              editable={editable}
              layout="no-cover"
              allClasses={allClasses}
              allNodes={allNodes}
              allTags={allTags}
              onNodeClick={onNodeClick}
              onNodeShiftClick={onNodeShiftClick}
              onContentChange={onContentChange}
              customContextMenu={customContextMenu}
              collapsed={collapsedColumns.has(column.id)}
              onToggleCollapse={() => toggleColumn(column.id)}
              showBreadcrumbs={showBreadcrumbs}
            />
          ))}
        </div>

        <DragOverlay>
          {dndActiveNode ? (
            <div className="node-kanban-view__kanban-card node-kanban-view__kanban-card--overlay">
              <NodeCard
                node={dndActiveNode}
                index={0}
                layout="no-cover"
                sortable={false}
                isDragging={true}
                isDropTarget={false}
                editable={editable}
                allClasses={allClasses}
                allNodes={allNodes}
                allTags={allTags}
                onNodeClick={onNodeClick}
                onNodeShiftClick={onNodeShiftClick}
                onContentChange={onContentChange}
                customContextMenu={customContextMenu}
                showBreadcrumbs={showBreadcrumbs}
                context="kanban"
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    );
  }

  // ─── Normal grid view ────────────────────────────────────────
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
          showBreadcrumbs={showBreadcrumbs}
          context="masonry"
        />
      ))}
    </div>
  );
});

registerView({
  id: 'kanban',
  label: 'Kanban',
  icon: 'mdi mdi-view-grid',
  component: KanbanView,
  capabilities: { groupBy: true, cardLayout: true, sorting: true },
});
