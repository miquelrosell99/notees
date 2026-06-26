/**
 * ConflictResolutionModal — three-way diff UI for v2 sync conflicts.
 *
 * Shows base / ours / theirs for text edits and tree moves, then lets the
 * user keep their local changes, accept the server state, or close and edit
 * the block manually.
 */

import { useMemo, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useModalStore } from '@/stores/modalStore';
import { useConflictStore } from '../stores/conflictStore';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import { getOperationRuntime } from '@/runtime';
import { localSyncEngine } from '../engine/localSyncEngine';
import { useLivePresenceStore } from '@/features/collab';
import DiffMatchPatch from 'diff-match-patch';
import type { Node } from '@/types/api';
import type { JSX } from 'react';
import './ConflictResolutionModal.css';

function nodeNameToText(node: Node | null): string {
  if (!node) return '';
  try {
    const ast = JSON.parse(node.name || '[]');
    return stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY });
  } catch {
    return node.name || '';
  }
}

function InlineDiff({ base, ours, theirs }: { base: string; ours: string; theirs: string }): JSX.Element {
  const dmp = useMemo(() => new DiffMatchPatch(), []);
  const diff = useMemo(() => dmp.diff_main(ours, theirs), [dmp, ours, theirs]);

  if (!base && !ours && !theirs) {
    return <span className="conflict-resolution-modal__empty">No text content</span>;
  }

  return (
    <div className="conflict-resolution-modal__diff">
      {diff.map(([type, text], index) => {
        const className =
          type === -1
            ? 'conflict-resolution-modal__diff-removed'
            : type === 1
              ? 'conflict-resolution-modal__diff-added'
              : 'conflict-resolution-modal__diff-equal';
        return (
          <span key={index} className={className}>
            {text}
          </span>
        );
      })}
    </div>
  );
}

function TreePane({ label, node }: { label: string; node: Node | null }): JSX.Element {
  if (!node) {
    return (
      <div className="conflict-resolution-modal__pane">
        <h4 className="conflict-resolution-modal__pane-title">{label}</h4>
        <span className="conflict-resolution-modal__empty">Unavailable</span>
      </div>
    );
  }

  const children = node.children ?? [];
  return (
    <div className="conflict-resolution-modal__pane">
      <h4 className="conflict-resolution-modal__pane-title">{label}</h4>
      <div className="conflict-resolution-modal__tree-node">
        <span className="conflict-resolution-modal__tree-label">{nodeNameToText(node) || '(empty)'}</span>
        {children.length > 0 && (
          <ul className="conflict-resolution-modal__tree-children">
            {children.map((child) => (
              <li key={child.uuid} className="conflict-resolution-modal__tree-child">
                {nodeNameToText(child) || '(empty)'}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ConflictResolutionModal(): JSX.Element | null {
  const { isConflictResolutionModalOpen, conflictResolutionNodeUuid, setConflictResolutionModalOpen } =
    useModalStore();
  const conflicts = useConflictStore((s) => s.conflicts);
  const resolveConflict = useConflictStore((s) => s.resolveConflict);
  const clearConflict = useLivePresenceStore((s) => s.setConflict);

  const conflict = useMemo(() => {
    if (!conflictResolutionNodeUuid) return null;
    for (const c of conflicts.values()) {
      if (c.nodeUuid === conflictResolutionNodeUuid) return c;
    }
    return null;
  }, [conflicts, conflictResolutionNodeUuid]);

  const handleClose = useCallback(() => {
    setConflictResolutionModalOpen(false, null);
  }, [setConflictResolutionModalOpen]);

  const handleKeepMine = useCallback(() => {
    if (!conflict) return;
    const runtime = getOperationRuntime();
    for (const opId of conflict.operationIds) {
      runtime.retryOperation(opId);
    }
    // Re-queue immediately so SyncManagerV2 retries on the next tick.
    void localSyncEngine.flush();
    resolveConflict(conflict.workspaceUuid, conflict.nodeUuid);
    clearConflict(conflict.nodeUuid, conflict.nodeUuid, null);
    handleClose();
  }, [conflict, resolveConflict, clearConflict, handleClose]);

  const handleKeepTheirs = useCallback(() => {
    if (!conflict) return;
    const runtime = getOperationRuntime();
    for (const opId of conflict.operationIds) {
      runtime.failOperation(opId, 'User accepted server state');
      void localSyncEngine.remove(opId);
    }
    resolveConflict(conflict.workspaceUuid, conflict.nodeUuid);
    clearConflict(conflict.nodeUuid, conflict.nodeUuid, null);
    handleClose();
  }, [conflict, resolveConflict, clearConflict, handleClose]);

  if (!isConflictResolutionModalOpen || !conflict) {
    return null;
  }

  const isTextConflict = conflict.conflictType === 'text_edit';
  const baseText = nodeNameToText(conflict.baseNode);
  const ourText = nodeNameToText(conflict.ourNode);
  const theirText = nodeNameToText(conflict.theirNode);

  return (
    <Modal
      isOpen
      onClose={handleClose}
      title="Resolve sync conflict"
      size="xl"
      footer={
        <div className="conflict-resolution-modal__footer">
          <Button variant="default" onClick={handleClose}>
            Manual edit
          </Button>
          <Button variant="default" onClick={handleKeepTheirs}>
            Keep theirs
          </Button>
          <Button variant="primary" onClick={handleKeepMine}>
            Keep mine
          </Button>
        </div>
      }
    >
      <div className="conflict-resolution-modal">
        <p className="conflict-resolution-modal__hint">
          {isTextConflict
            ? 'This block was edited on another device. Review the versions below and choose which one to keep.'
            : 'This block or its children were moved or deleted on another device. Review the versions below.'}
        </p>

        {isTextConflict ? (
          <div className="conflict-resolution-modal__panes">
            <div className="conflict-resolution-modal__pane">
              <h4 className="conflict-resolution-modal__pane-title">Base</h4>
              <p>{baseText || '(empty)'}</p>
            </div>
            <div className="conflict-resolution-modal__pane">
              <h4 className="conflict-resolution-modal__pane-title">Yours</h4>
              <p>{ourText || '(empty)'}</p>
            </div>
            <div className="conflict-resolution-modal__pane">
              <h4 className="conflict-resolution-modal__pane-title">Theirs</h4>
              <p>{theirText || '(empty)'}</p>
            </div>
            <div className="conflict-resolution-modal__pane conflict-resolution-modal__pane--wide">
              <h4 className="conflict-resolution-modal__pane-title">Diff (Yours → Theirs)</h4>
              <InlineDiff base={baseText} ours={ourText} theirs={theirText} />
            </div>
          </div>
        ) : (
          <div className="conflict-resolution-modal__panes">
            <TreePane label="Base" node={conflict.baseNode} />
            <TreePane label="Yours" node={conflict.ourNode} />
            <TreePane label="Theirs" node={conflict.theirNode} />
          </div>
        )}
      </div>
    </Modal>
  );
}
