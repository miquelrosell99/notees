/**
 * LinkEditModal — Modal for editing inline link pills.
 *
 * Two modes via a toggle:
 *   - Node link: pick a target node via NodeSelector (same as property cells)
 *   - URL link:  enter a plain URL
 *
 * Both modes share a custom display-label field.
 */

import { useState, useCallback, useEffect } from 'react';
import { mdiLinkVariant, mdiWeb } from '@mdi/js';
import { Modal } from '@/components/core/Modal';
import { Button } from '@/components/core/Button';
import { SelectionButton } from '@/components/core/SelectionButton';
import { NodeSelector } from '@/components/nodes/NodeSelector';
import { useNodeByUuid } from '@/hooks/useNodeQueries';
import { parseLinkId } from '@/lib/astBuilder';
import type { PillRefType } from '../nodes/PillNode';
import type { Node } from '@/types/api';
import './LinkEditModal.css';

export interface LinkEditModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Current compound link ID (nodeUuid:linkUuid) */
  linkId: string;
  /** Current ref type */
  refType: PillRefType;
  /** Current URL (for URL pills) */
  currentUrl?: string;
  /** Current custom label (from node_link.name) */
  currentLabel?: string | null;
  /** Called when saving changes */
  onSave: (result: LinkEditResult) => void;
  /** Called when closing without saving */
  onClose: () => void;
}

export type LinkMode = 'node' | 'url';

export interface LinkEditResult {
  /** Link mode — node or URL */
  mode: LinkMode;
  /** New target node (node mode only, null if unchanged) */
  targetNode: Node | null;
  /** URL string (url mode only) */
  url?: string;
  /** Custom label (null to clear) */
  label: string | null;
  /** Original link ID for reference */
  originalLinkId: string;
}

const LINK_MODE_OPTIONS = [
  { value: 'node' as const, icon: mdiLinkVariant, label: 'Node link' },
  { value: 'url' as const, icon: mdiWeb, label: 'URL link' },
];

export function LinkEditModal({
  isOpen,
  linkId,
  refType,
  currentUrl,
  currentLabel,
  onSave,
  onClose,
}: LinkEditModalProps) {
  const { nodeUuid } = parseLinkId(linkId);
  const { data: currentNode } = useNodeByUuid(nodeUuid);

  // ─── State ─────────────────────────────────────────────────

  const [linkMode, setLinkMode] = useState<LinkMode>(refType === 'url' ? 'url' : 'node');
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [url, setUrl] = useState(currentUrl ?? '');
  const [label, setLabel] = useState(currentLabel ?? '');

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setLinkMode(refType === 'url' ? 'url' : 'node');
      setSelectedNode(null);
      setUrl(currentUrl ?? '');
      setLabel(currentLabel ?? '');
    }
  }, [isOpen, currentLabel, refType, currentUrl]);

  // The effective node value (for NodeSelector) is the selected node or the current node
  const effectiveNodeId = selectedNode?.id ?? currentNode?.id ?? null;

  // ─── Handlers ──────────────────────────────────────────────

  const handleNodeChange = useCallback((value: number | number[] | null) => {
    // When cleared, reset selection
    if (value === null) {
      setSelectedNode(null);
    }
  }, []);

  const handleNodeAdd = useCallback((node: Node) => {
    setSelectedNode(node);
  }, []);

  const handleSave = useCallback(() => {
    const trimmedLabel = label.trim();

    if (linkMode === 'url') {
      onSave({
        mode: 'url',
        targetNode: null,
        url: url.trim(),
        label: trimmedLabel || null,
        originalLinkId: linkId,
      });
    } else {
      onSave({
        mode: 'node',
        targetNode: selectedNode,
        label: trimmedLabel || null,
        originalLinkId: linkId,
      });
    }
  }, [linkMode, selectedNode, url, label, linkId, onSave]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    }
  }, [handleSave]);

  // ─── Render ────────────────────────────────────────────────

  const footer = (
    <div className="link-edit-modal__footer">
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="primary" onClick={handleSave}>
        Save
      </Button>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Edit Link"
      size="sm"
      footer={footer}
      className="link-edit-modal"
    >
      <div className="link-edit-modal__body" onKeyDown={handleKeyDown}>
        {/* Mode toggle */}
        <div className="link-edit-modal__section link-edit-modal__mode-section">
          <SelectionButton
            options={LINK_MODE_OPTIONS}
            value={linkMode}
            onChange={(v) => setLinkMode(v as LinkMode)}
            size="sm"
          />
        </div>

        {/* Link target section */}
        <div className="link-edit-modal__section">
          <label className="link-edit-modal__label">
            {linkMode === 'node' ? 'Link Target' : 'URL'}
          </label>
          {linkMode === 'node' ? (
            <NodeSelector
              trigger="select"
              value={effectiveNodeId}
              searchMode="pages"
              placeholder="Select a node..."
              searchPlaceholder="Search pages..."
              onChange={handleNodeChange}
              onAdd={handleNodeAdd}
            />
          ) : (
            <input
              type="text"
              className="link-edit-modal__input"
              placeholder="https://..."
              value={url}
              onChange={e => setUrl(e.target.value)}
              autoComplete="off"
              autoFocus
            />
          )}
        </div>

        {/* Custom label section */}
        <div className="link-edit-modal__section">
          <label className="link-edit-modal__label" htmlFor="link-label-input">
            Display Label
          </label>
          <input
            id="link-label-input"
            type="text"
            className="link-edit-modal__input"
            placeholder=""
            value={label}
            onChange={e => setLabel(e.target.value)}
            autoComplete="off"
          />
          <span className="link-edit-modal__hint">
            {linkMode === 'node'
              ? 'Leave empty to use the node name'
              : 'Leave empty to use the URL'}
          </span>
        </div>
      </div>
    </Modal>
  );
}

export default LinkEditModal;
