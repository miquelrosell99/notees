/**
 * CardModeView — Card grid container.
 *
 * Reproduces the old NodeCardView grid layout:
 * - CSS column-based masonry layout
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
import { getNodeGraphRuntime } from '../runtime/NodeGraphRuntime';
import { apiNodesToGraphNodes } from '../hooks/useRuntimeSync';
import { useStructureSync } from '../hooks/useStructureSync';
import { useBlockPersist } from '../hooks/useBlockPersist';
import type { Node } from '@/types';
import type { NodeCardViewProps } from '@/types/nodeCollection';
import { useClasses } from '@/hooks';
import { useAppStore } from '@/stores';
import { Button } from '../components/core/Button';
import { Card } from '../components/core/Card';
import { mdiPlus } from '@mdi/js';
import { sortBySequence } from '@/utils/nodeSort';

import './CardModeView.css';

// ─── Component ────────────────────────────────────────────────────

export function CardModeView({
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
}: NodeCardViewProps): JSX.Element {
  const viewId = useId();

  // ─── Sync structural changes to database ───────────────────
  // Listens to runtime structure_changed events (indent, outdent, reorder within cards)
  // and persists parent_id and sequence to the backend
  useStructureSync();

  // ─── Persist new blocks to database ────────────────────────
  // Watches for runtime nodes without serverId and creates them via API
  useBlockPersist();

  // ─── Sync nodes to runtime ──────────────────────────────────
  // Flatten all nodes (including children) and upsert into the
  // runtime so that NodeBlockPlugin can project them.
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

  // Group nodes by page when groupBy='page'
  const groupedNodes = useMemo(() => {
    if (groupBy !== 'page') {
      return null; // No grouping
    }

    // Group nodes by their page
    const groups = new Map<string, { page: Node | null; nodes: Node[] }>();
    
    for (const node of sortedNodes) {
      // Use page info from metadata (for linked refs) or from the node itself
      const pageKey = (node as any).page_id 
        ? `page-${(node as any).page_id}` 
        : node.is_page 
          ? `self-${node.id}` 
          : 'no-page';
      
      if (!groups.has(pageKey)) {
        // Extract page node if available
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
  }, [sortedNodes, groupBy]);

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

  // Kanban view (grouped by page)
  if (groupedNodes) {
    return (
      <div className={gridClassName} ref={containerRef}>
        {groupedNodes.map((group, groupIndex) => {
          const groupKey = group.page?.id 
            ? `page-${group.page.id}` 
            : `group-${groupIndex}`;
          
          return (
            <div key={groupKey} className="node-card-view__kanban-column">
              <div className="node-card-view__kanban-header">
                {group.page ? (
                  <>
                    {group.page.icon && <span className="node-card-view__kanban-icon">{group.page.icon}</span>}
                    <span className="node-card-view__kanban-title">{group.page.name || 'Untitled'}</span>
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
