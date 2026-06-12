/**
 * WorkspaceActionsMenu — Three-dot dropdown menu for workspace card actions.
 */
import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { useClickOutside } from '@/hooks/useClickOutside';
import type { WorkspaceInfo } from '@/features/workspace/api/workspaces';

interface WorkspaceActionsMenuProps {
  workspace: WorkspaceInfo;
  onRename: (workspace: WorkspaceInfo) => void;
  onExport: (workspace: WorkspaceInfo) => void;
  onRestore: (workspaceUuid: string) => void;
  onShare: (workspace: WorkspaceInfo) => void;
  onDelete: (workspaceUuid: string) => void;
  disabled?: boolean;
}

export function WorkspaceActionsMenu({
  workspace,
  onRename,
  onExport,
  onRestore,
  onShare,
  onDelete,
  disabled,
}: WorkspaceActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useClickOutside(menuRef, () => setIsOpen(false), isOpen);

  const handleToggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  const items: ContextMenuItem[] = [
    {
      id: 'rename',
      label: 'Rename',
      icon: 'mdi mdi-pencil-outline',
      onClick: () => { onRename(workspace); handleClose(); },
    },
    {
      id: 'export',
      label: 'Export',
      icon: 'mdi mdi-export',
      onClick: () => { onExport(workspace); handleClose(); },
    },
    {
      id: 'restore',
      label: 'Restore from dump',
      icon: 'mdi mdi-backup-restore',
      onClick: () => { onRestore(workspace.uuid); handleClose(); },
    },
    {
      id: 'share',
      label: 'Share workspace',
      icon: 'mdi mdi-share-variant-outline',
      onClick: () => { onShare(workspace); handleClose(); },
    },
    { id: 'sep-delete', label: '', separator: true },
    {
      id: 'delete',
      label: 'Delete',
      icon: 'mdi mdi-trash-can-outline',
      danger: true,
      onClick: () => { onDelete(workspace.uuid); handleClose(); },
    },
  ];

  return (
    <div className="workspace-actions-menu" ref={menuRef}>
      <Button aria-label="Workspace actions"
        ref={buttonRef}
        variant="ghost"
        size="sm"
        icon="mdi mdi-dots-vertical"
        title="Workspace actions"
        onClick={handleToggle}
        disabled={disabled}
        className={isOpen ? 'active' : ''}
      />
      {isOpen && createPortal(
        <ContextMenu
          items={items}
          anchorEl={buttonRef.current}
          onClose={handleClose}
          alignRight
          inline
        />,
        document.body
      )}
    </div>
  );
}
