/**
 * KanbanView — First-class Kanban board view.
 *
 * Features:
 * - Columns derived from a property's selection options (or discovered values)
 * - Drag-and-drop cards between columns using @dnd-kit
 * - Moving a card to a different column updates its property value
 * - Column collapse/expand
 * - Reuses NodeCard for consistent card rendering
 */

import { useState, useCallback, useMemo, memo } from 'react';
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
import type { Node } from '@/types';
import type { NodeCollectionViewBaseProps } from '@/types/nodeCollection';
import type { Property } from '@/types/api';
import { useSetNodeProperty } from '@/hooks/useProperties';
import { useClasses, useNodes, useTags } from '@/hooks';
import { NodeCard } from './CardItem';
import { getPropertyGroupInfo } from './viewHelpers';
import { sortBySequence } from '@/utils/nodeSort';
import { NodeIcon } from '@/components/core/icons';
import { Button } from '@/components/core/Button';
import './KanbanView.css';

// ==================== Types ====================

export interface NodeKanbanViewProps extends NodeCollectionViewBaseProps {
  /** Property to group columns by (defaults to task status if available) */
  groupByProperty?: Property;
  /** Callback when Add button is clicked */
  onAdd?: () => void;
  /** Custom context menu */
  customContextMenu?: React.ComponentType<{
    node: Node;
    position: { x: number; y: number };
    onClose: () => void;
  }>;
}

interface KanbanColumnData {
  id: string;
  label: string;
  icon: string | null;
  nodes: Node[];
  /** The raw property value this column represents */
  value: unknown;
}

// ==================== Draggable Card ====================

interface KanbanCardProps {
  node: Node;
  editable: boolean;
  layout: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right';
  allClasses?: Node[];
  allNodes?: Node[];
  allTags?: Node[];
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onContentChange?: (nodeId: number, content: string) => void;
  customContextMenu?: React.ComponentType<{
    node: Node;
    position: { x: number; y: number };
    onClose: () => void;
  }>;
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
}: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `kanban-card-${node.id}`,
    data: { type: 'card', nodeId: node.id },
  });

  return (
    <div
      ref={setNodeRef}
      className={`kanban-card-wrapper ${isDragging ? 'kanban-card-wrapper--dragging' : ''}`}
      {...attributes}
      {...listeners}
    >
      <NodeCard
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
      />
    </div>
  );
}

// ==================== Droppable Column ====================

interface KanbanColumnProps {
  column: KanbanColumnData;
  editable: boolean;
  layout: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right';
  allClasses?: Node[];
  allNodes?: Node[];
  allTags?: Node[];
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onContentChange?: (nodeId: number, content: string) => void;
  customContextMenu?: React.ComponentType<{
    node: Node;
    position: { x: number; y: number };
    onClose: () => void;
  }>;
  collapsed: boolean;
  onToggleCollapse: () => void;
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
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `kanban-column-${column.id}`,
    data: { type: 'column', columnId: column.id, value: column.value },
  });

  return (
    <div
      ref={setNodeRef}
      className={`kanban-column ${isOver ? 'kanban-column--over' : ''} ${collapsed ? 'kanban-column--collapsed' : ''}`}
      data-column-id={column.id}
    >
      <div
        className="kanban-column__header"
        onClick={onToggleCollapse}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleCollapse(); } }}
        role="button"
        tabIndex={0}
      >
        {column.icon && <NodeIcon icon={column.icon} size="xs" className="kanban-column__icon" />}
        <span className="kanban-column__title">{column.label}</span>
        <span className="kanban-column__count">{column.nodes.length}</span>
        <Button
          icon={collapsed ? 'mdi mdi-chevron-right' : 'mdi mdi-chevron-down'}
          variant="ghost"
          size="xs"
          className="kanban-column__collapse-btn"
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
        />
      </div>

      {!collapsed && (
        <div className="kanban-column__cards">
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== Main Component ====================

export const KanbanView = memo(function KanbanView(props: NodeKanbanViewProps) {
  const {
    nodes,
    editable = true,
    groupByProperty,
    onNodeClick,
    onNodeShiftClick,
    onContentChange,
    onAdd,
    customContextMenu,
  } = props;
  const setNodeProperty = useSetNodeProperty();
  const { data: allClasses } = useClasses();
  const { data: allNodes } = useNodes();
  const { data: allTags } = useTags();

  // Column collapse state (local, not persisted for now)
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(new Set());

  const toggleColumn = useCallback((columnId: string) => {
    setCollapsedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(columnId)) next.delete(columnId);
      else next.add(columnId);
      return next;
    });
  }, []);

  // Build columns from property options + discovered values
  const columns = useMemo((): KanbanColumnData[] => {
    if (!groupByProperty) {
      // No grouping property: single column with all nodes
      return [{ id: 'all', label: 'All', icon: null, nodes: sortBySequence(nodes), value: null }];
    }

    const propId = String(groupByProperty.id);
    const valueMap = new Map<string, KanbanColumnData>();

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
    for (const node of nodes) {
      const rawValue = (node.properties as Record<string, unknown> | undefined)?.[propId] ?? null;

      if (rawValue === null || rawValue === undefined) {
        if (!valueMap.has('none')) {
          valueMap.set('none', { id: 'none', label: 'None', icon: null, nodes: [], value: null });
        }
        valueMap.get('none')!.nodes.push(node);
      } else {
        const { label, icon } = getPropertyGroupInfo(groupByProperty, rawValue);
        // For selection properties, try to match by option id for stable keys
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

    // Sort columns: option-defined ones first (by option sequence), then discovered ones, then None last
    const sorted = Array.from(valueMap.values());
    sorted.sort((a, b) => {
      const aIsNone = a.id === 'none' ? 1 : 0;
      const bIsNone = b.id === 'none' ? 1 : 0;
      if (aIsNone !== bIsNone) return aIsNone - bIsNone;

      // If both are from options, sort by option sequence
      if (groupByProperty.type === 'selection' && groupByProperty.options) {
        const aOpt = groupByProperty.options.find((o) => `opt-${o.id}` === a.id);
        const bOpt = groupByProperty.options.find((o) => `opt-${o.id}` === b.id);
        if (aOpt && bOpt) return (aOpt.sequence ?? 0) - (bOpt.sequence ?? 0);
      }

      return a.label.localeCompare(b.label);
    });

    return sorted.map((col) => ({ ...col, nodes: sortBySequence(col.nodes) }));
  }, [nodes, groupByProperty]);

  // Drag state
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeNode = useMemo(() => {
    if (!activeId) return null;
    const nodeId = Number(activeId.replace('kanban-card-', ''));
    return nodes.find((n) => n.id === nodeId) ?? null;
  }, [activeId, nodes]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over || !active.data.current) return;

    const activeNodeId = Number(String(active.id).replace('kanban-card-', ''));
    const overData = over.data.current as { type?: string; columnId?: string; value?: unknown } | undefined;

    if (!overData || overData.type !== 'column') return;

    const targetColumn = columns.find((c) => c.id === overData.columnId);
    if (!targetColumn || !groupByProperty) return;

    // Don't mutate if dropping on the same column
    const activeNodeData = active.data.current as { type?: string; nodeId?: number } | undefined;
    const sourceColumn = columns.find((c) => c.nodes.some((n) => n.id === activeNodeData?.nodeId));
    if (sourceColumn && sourceColumn.id === targetColumn.id) return;

    const newValue = targetColumn.value;
    setNodeProperty.mutate({
      nodeId: activeNodeId,
      propertyId: groupByProperty.id,
      value: newValue,
    });
  }, [columns, groupByProperty, setNodeProperty]);

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="kanban-view">
        {columns.map((column) => (
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
          />
        ))}
      </div>

      <DragOverlay>
        {activeNode ? (
          <div className="kanban-card-wrapper kanban-card-wrapper--overlay">
            <NodeCard
              node={activeNode}
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
            />
          </div>
        ) : null}
      </DragOverlay>

      {onAdd && (
        <Button
          icon="mdi mdi-plus"
          variant="ghost"
          size="sm"
          onClick={onAdd}
          className="kanban-view__add-btn"
        />
      )}
    </DndContext>
  );
});

import { registerView } from './registry';
registerView({
  id: 'kanban',
  label: 'Kanban',
  icon: 'mdi mdi-view-column',
  component: KanbanView,
  capabilities: { groupBy: true },
});
