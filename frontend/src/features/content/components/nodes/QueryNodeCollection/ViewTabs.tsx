/**
 * ViewTabs Component
 *
 * Draggable tabs for switching between the saved NodeViews of one section.
 * Each tab has an actions menu (rename, duplicate, set as default, delete).
 * Dragging a tab reorders the views server-side.
 */
import { useState, useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { Icon } from '@/components/ui/icons';
import { useDndSensors } from '@/features/content/hooks/dnd/useDndSensors';
import type { NodeView } from '@/types/nodeView';
import './ViewTabs.css';

interface ViewTabsProps {
  views: NodeView[];
  activeViewUuid: string | undefined;
  onSelect: (viewUuid: string) => void;
  onReorder: (viewUuids: string[]) => void;
  onRename: (view: NodeView) => void;
  onDuplicate: (view: NodeView) => void;
  onSetDefault: (view: NodeView) => void;
  onDelete: (view: NodeView) => void;
}

export function ViewTabs({
  views,
  activeViewUuid,
  onSelect,
  onReorder,
  onRename,
  onDuplicate,
  onSetDefault,
  onDelete,
}: ViewTabsProps) {
  const sensors = useDndSensors();
  const [menuState, setMenuState] = useState<{ view: NodeView; anchor: HTMLElement } | null>(null);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = views.findIndex((v) => v.uuid === active.id);
    const newIndex = views.findIndex((v) => v.uuid === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      onReorder(arrayMove(views.map((v) => v.uuid), oldIndex, newIndex));
    }
  }, [views, onReorder]);

  const menuItems: ContextMenuItem[] = menuState
    ? [
        {
          id: 'rename',
          label: 'Rename',
          icon: 'mdi mdi-pencil-outline',
          onClick: () => onRename(menuState.view),
        },
        {
          id: 'duplicate',
          label: 'Duplicate',
          icon: 'mdi mdi-content-copy',
          onClick: () => onDuplicate(menuState.view),
        },
        {
          id: 'set-default',
          label: 'Set as default',
          icon: 'mdi mdi-star-outline',
          disabled: menuState.view.is_default,
          onClick: () => onSetDefault(menuState.view),
        },
        { id: 'sep-1', label: '', separator: true },
        {
          id: 'delete',
          label: 'Delete',
          icon: 'mdi mdi-delete-outline',
          danger: true,
          disabled: menuState.view.is_default || views.length <= 1,
          onClick: () => {
            if (window.confirm(`Delete view "${menuState.view.name}"?`)) {
              onDelete(menuState.view);
            }
          },
        },
      ]
    : [];

  return (
    <div className="view-tabs" role="tablist" aria-label="Saved views">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={views.map((v) => v.uuid)} strategy={horizontalListSortingStrategy}>
          {views.map((view) => (
            <ViewTab
              key={view.uuid}
              view={view}
              active={view.uuid === activeViewUuid}
              onSelect={() => onSelect(view.uuid)}
              onOpenMenu={(anchor) => setMenuState({ view, anchor })}
            />
          ))}
        </SortableContext>
      </DndContext>
      {menuState && (
        <ContextMenu
          items={menuItems}
          anchorEl={menuState.anchor}
          onClose={() => setMenuState(null)}
        />
      )}
    </div>
  );
}

function ViewTab({
  view,
  active,
  onSelect,
  onOpenMenu,
}: {
  view: NodeView;
  active: boolean;
  onSelect: () => void;
  onOpenMenu: (anchor: HTMLElement) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: view.uuid });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`view-tabs__tab${active ? ' view-tabs__tab--active' : ''}`}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={active}
    >
      <button type="button" className="view-tabs__tab-button" onClick={onSelect} title={view.name}>
        {view.is_default && (
          <span className="view-tabs__tab-default-icon" aria-label="Default view" title="Default view">
            <Icon path="mdi mdi-star" size={0.5} />
          </span>
        )}
        <span className="view-tabs__tab-label">{view.name}</span>
      </button>
      <button
        type="button"
        className="view-tabs__tab-menu"
        aria-label={`Actions for view ${view.name}`}
        // Keep the drag sensor from swallowing the menu click
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onOpenMenu(e.currentTarget);
        }}
      >
        <Icon path="mdi mdi-chevron-down" size={0.5} />
      </button>
    </div>
  );
}
