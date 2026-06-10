/**
 * WhiteboardContextMenu — Right-click context menu for whiteboard elements and canvas.
 */
import React from 'react';
import { ContextMenu } from '@/components/ui/ContextMenu';
import type { UseWhiteboardReturn } from '@/hooks/useWhiteboard';
import type { WhiteboardCardElement } from '@/types/whiteboard';
import { useWhiteboardStore } from '@/stores/whiteboardStore';

interface WhiteboardContextMenuProps {
  wb: UseWhiteboardReturn;
  position: { x: number; y: number } | null;
  elementId: string | null;
  onClose: () => void;
  onOpenNode: (nodeId: number) => void;
  onAddCardAtPosition: (x: number, y: number) => void;
  onAddReferenceCardAtPosition: (x: number, y: number) => void;
}

export const WhiteboardContextMenu: React.FC<WhiteboardContextMenuProps> = ({
  wb,
  position,
  elementId,
  onClose,
  onOpenNode,
  onAddCardAtPosition,
  onAddReferenceCardAtPosition,
}) => {
  const { gridVisible, gridSnap } = useWhiteboardStore();

  if (!position) return null;

  const element = elementId ? wb.data.elements.find(el => el.id === elementId) : null;
  const selectedIds = [...wb.interaction.selectedIds];
  const selectedCount = selectedIds.length;

  // Build menu items based on context
  const items: Array<{
    id: string;
    label: string;
    icon?: string;
    shortcut?: string;
    danger?: boolean;
    separator?: boolean;
    disabled?: boolean;
    onClick?: () => void;
  }> = [];

  if (element) {
    // Element context
    if (element.type === 'card') {
      items.push({
        id: 'open-node',
        label: 'Open Page',
        icon: "mdi mdi-open-in-new",
        onClick: () => { onOpenNode((element as WhiteboardCardElement).nodeId); onClose(); },
      });
      items.push({
        id: 'toggle-collapse',
        label: (element as any).collapsed ? 'Expand Card' : 'Collapse Card',
        icon: (element as any).collapsed ? "mdi mdi-chevron-down" : "mdi mdi-chevron-up",
        onClick: () => { wb.updateElement(element.id, { collapsed: !(element as any).collapsed }); onClose(); },
      });
      items.push({ id: 'sep-card', label: '', separator: true });
    }

    // Color submenu for shapes
    if (element.type === 'shape') {
      items.push({
        id: 'edit-text',
        label: 'Edit Text',
        icon: "mdi mdi-pencil",
        onClick: () => { onClose(); /* editing handled by double-click */ },
      });
      items.push({ id: 'sep-shape', label: '', separator: true });
    }

    // Common element actions
    items.push({
      id: 'copy',
      label: `Copy${selectedCount > 1 ? ` (${selectedCount})` : ''}`,
      icon: "mdi mdi-content-copy",
      shortcut: 'Ctrl+C',
      onClick: () => { wb.copySelectedElements(selectedIds.length > 0 ? selectedIds : [element.id]); onClose(); },
    });

    items.push({
      id: 'duplicate',
      label: `Duplicate${selectedCount > 1 ? ` (${selectedCount})` : ''}`,
      icon: "mdi mdi-content-duplicate",
      shortcut: 'Ctrl+D',
      onClick: () => { wb.duplicateElements(selectedIds.length > 0 ? selectedIds : [element.id]); onClose(); },
    });

    items.push({
      id: 'lock',
      label: element.locked ? 'Unlock' : 'Lock',
      icon: element.locked ? "mdi mdi-lock-open-outline" : "mdi mdi-lock-outline",
      onClick: () => {
        const ids = selectedIds.length > 0 ? selectedIds : [element.id];
        for (const id of ids) {
          wb.updateElement(id, { locked: !element.locked });
        }
        onClose();
      },
    });

    items.push({ id: 'sep-z', label: '', separator: true });

    items.push({
      id: 'bring-front',
      label: 'Bring to Front',
      icon: "mdi mdi-arrange-bring-to-front",
      shortcut: ']',
      onClick: () => { wb.bringToFront(selectedIds.length > 0 ? selectedIds : [element.id]); onClose(); },
    });

    items.push({
      id: 'send-back',
      label: 'Send to Back',
      icon: "mdi mdi-arrange-send-to-back",
      shortcut: '[',
      onClick: () => { wb.sendToBack(selectedIds.length > 0 ? selectedIds : [element.id]); onClose(); },
    });

    items.push({ id: 'sep-delete', label: '', separator: true });

    items.push({
      id: 'delete',
      label: `Delete${selectedCount > 1 ? ` (${selectedCount})` : ''}`,
      icon: "mdi mdi-delete-outline",
      shortcut: 'Del',
      danger: true,
      onClick: () => { wb.removeElements(selectedIds.length > 0 ? selectedIds : [element.id]); onClose(); },
    });
  } else {
    // Canvas context (no element selected)
    items.push({
      id: 'add-card',
      label: 'Add Block',
      icon: "mdi mdi-card-plus-outline",
      onClick: () => {
        onAddCardAtPosition(position.x, position.y);
        onClose();
      },
    });

    items.push({
      id: 'add-reference-card',
      label: 'Add Reference',
      icon: "mdi mdi-link-variant",
      onClick: () => {
        onAddReferenceCardAtPosition(position.x, position.y);
        onClose();
      },
    });

    items.push({
      id: 'add-text',
      label: 'Add Text',
      icon: "mdi mdi-format-text",
      shortcut: 'T',
      onClick: () => { wb.setTool('text'); onClose(); },
    });

    items.push({
      id: 'add-shape',
      label: 'Add Shape',
      icon: "mdi mdi-rectangle-outline",
      shortcut: 'R',
      onClick: () => { wb.setTool('rectangle'); onClose(); },
    });

    items.push({ id: 'sep-canvas-1', label: '', separator: true });

    items.push({
      id: 'paste',
      label: 'Paste',
      icon: "mdi mdi-content-paste",
      shortcut: 'Ctrl+V',
      onClick: () => { wb.pasteElements(); onClose(); },
    });

    items.push({ id: 'sep-canvas-2', label: '', separator: true });

    items.push({
      id: 'select-all',
      label: 'Select All',
      icon: "mdi mdi-select-all",
      shortcut: 'Ctrl+A',
      onClick: () => { wb.selectElements(wb.data.elements.map(el => el.id)); onClose(); },
    });

    items.push({
      id: 'zoom-fit',
      label: 'Zoom to Fit',
      icon: "mdi mdi-fit-to-screen",
      shortcut: 'Ctrl+1',
      onClick: () => { wb.zoomToFit(); onClose(); },
    });

    items.push({
      id: 'zoom-reset',
      label: 'Reset Zoom',
      icon: "mdi mdi-magnify",
      shortcut: 'Ctrl+0',
      onClick: () => { wb.setViewport({ x: 0, y: 0, zoom: 1 }); onClose(); },
    });

    items.push({ id: 'sep-canvas-3', label: '', separator: true });

    items.push({
      id: 'toggle-grid',
      label: gridVisible ? 'Hide Grid' : 'Show Grid',
      icon: "mdi mdi-grid",
      shortcut: 'G',
      onClick: () => { wb.toggleGrid(); onClose(); },
    });

    items.push({
      id: 'toggle-snap',
      label: gridSnap ? 'Disable Snap' : 'Enable Snap',
      icon: "mdi mdi-magnet",
      onClick: () => { wb.toggleSnap(); onClose(); },
    });
  }

  return (
    <ContextMenu
      items={items}
      position={position}
      onClose={onClose}
    />
  );
};
