/**
 * LinkEditModal — Modal for editing inline link pills.
 *
 * Two modes via a toggle:
 *   - Node link: pick a target node via NodeSelector (same as property cells)
 *   - URL link:  enter a plain URL
 *
 * Both modes share a custom display-label field.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { TextField } from '@/components/ui/TextField';
import { NodeSelector } from '@/features/content/components/nodes/NodeSelector';
import { useReferencedNode } from '@/contexts/useReferencedNode';
import { useNodeByUuid } from '@/hooks/useNodeQueries';
import { parseLinkId } from '@/lib/astBuilder';
import type { InlineLinkRefType } from '@/features/content/editor/nodes/InlineLinkNode';
import type { Node } from '@/types/api';
import { useClasses } from '@/hooks';
import './LinkEditModal.css';

export interface LinkEditModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Current compound link ID (nodeUuid:linkUuid) */
  linkId: string;
  /** Current ref type */
  refType: InlineLinkRefType;
  /** Current URL (for URL pills) */
  currentUrl?: string;
  /** Current custom label (from AST) */
  currentLabel?: string | null;
  /** Modal title — defaults to "Edit Link" */
  title?: string;
  /** When true, hides the URL mode option (node-only picker) */
  hideUrlMode?: boolean;
  /** Override the initial link mode (default: derived from refType) */
  initialMode?: LinkMode;
  /** Pre-fill the NodeSelector search field with this text */
  initialSearchQuery?: string;
  /** Called when saving changes */
  onSave: (result: LinkEditResult) => void;
  /** Called when closing without saving */
  onClose: () => void;
}

export type LinkMode = 'node' | 'block' | 'url';

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
  { value: 'node' as const, icon: "mdi mdi-link-variant", label: 'Page' },
  { value: 'block' as const, icon: "mdi mdi-text-box", label: 'Block' },
  { value: 'url' as const, icon: "mdi mdi-web", label: 'URL' },
];

export function LinkEditModal({
  isOpen,
  linkId,
  refType,
  currentUrl,
  currentLabel,
  title = 'Edit Link',
  hideUrlMode = false,
  initialMode,
  initialSearchQuery,
  onSave,
  onClose,
}: LinkEditModalProps) {
  const { nodeUuid } = parseLinkId(linkId);
  // Try pre-fetched map first; fall back to individual fetch only if missing
  const refNode = useReferencedNode(nodeUuid);
  const { data: fetchedNode } = useNodeByUuid(!refNode ? nodeUuid : null);
  const currentNode = refNode ?? fetchedNode;
  const { data: allClasses } = useClasses();

  // Check if this is an inline class link
  const isInlineClassLink = refType === 'class';
  
  // ─── State ─────────────────────────────────────────────────

  const [linkMode, setLinkMode] = useState<LinkMode>(
    initialMode ?? (refType === 'url' ? 'url' : 'node')
  );
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [url, setUrl] = useState(currentUrl ?? '');
  const [label, setLabel] = useState(currentLabel ?? '');
  
  // Check if the target node (current or selected) is a class
  const isTargetNodeClass = useMemo(() => {
    const targetNode = selectedNode || currentNode;
    if (!targetNode || !allClasses) return false;
    return allClasses.some(cls => cls.id === targetNode.id);
  }, [selectedNode, currentNode, allClasses]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setLinkMode(initialMode ?? (refType === 'url' ? 'url' : 'node'));
        setSelectedNode(null);
        setUrl(currentUrl ?? '');
        setLabel(currentLabel ?? '');;
    }
  }, [isOpen, currentLabel, refType, currentUrl, initialMode]);

  // The effective node value (for NodeSelector) is the selected node or the current node
  const effectiveNodeId = selectedNode?.id ?? currentNode?.id ?? null;

  // ─── Handlers ──────────────────────────────────────────────

  const handleNodeAdd = useCallback((node: Node) => {
    setSelectedNode(node);
  }, []);

  const handleNodeClear = useCallback(() => {
    setSelectedNode(null);
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
      // Both 'node' (page) and 'block' modes produce a node-type link
      onSave({
        mode: 'node',
        targetNode: selectedNode,
        label: trimmedLabel || null,
        originalLinkId: linkId,
      });
    }
  }, [linkMode, selectedNode, url, label, linkId, onSave]);

  // Enter anywhere inside the modal = save (capture phase to beat button activation).
  // NodeSelector dropdown is portaled outside .link-edit-modal, so it's naturally excluded.
  useEffect(() => {
    if (!isOpen) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target as HTMLElement;
      if (!target.closest('.link-edit-modal')) return;

      e.preventDefault();
      e.stopPropagation();
      handleSave();
    };

    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [isOpen, handleSave]);

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
      title={title}
      size="sm"
      footer={footer}
      className="link-edit-modal"
    >
      <div className="link-edit-modal__body">
        
        {/* Mode toggle */}
        <div className="link-edit-modal__section link-edit-modal__mode-section">
          {!hideUrlMode && (
            <SelectionButton
              options={LINK_MODE_OPTIONS}
              value={linkMode}
              onChange={(v) => setLinkMode(v as LinkMode)}
              size="sm"
            />
          )}
        {/* Inline class indicator */}
        {isInlineClassLink && (
          <div className="link-edit-modal__info">
            <span className="link-edit-modal__info-text">
              This is an <strong>inline class link</strong>. Editing this will also update the block's classes.
            </span>
          </div>
        )}
        </div>

        {/* Link target section */}
        <div className="link-edit-modal__section">
          <label className="link-edit-modal__label">
            {linkMode === 'node' ? 'Page' : linkMode === 'block' ? 'Block' : 'URL'}
          </label>
          {linkMode === 'node' ? (
            <>
              <NodeSelector
                trigger="select"
                value={effectiveNodeId}
                searchMode="pages"
                placeholder="Select a page..."
                searchPlaceholder="Search or create page..."
                initialSearchQuery={initialSearchQuery}
                onAdd={handleNodeAdd}
                onClearAll={handleNodeClear}
              />
              {isInlineClassLink && !isTargetNodeClass && (
                <span className="link-edit-modal__hint link-edit-modal__hint--warning">
                  If you select a node that is not a class, the "class" class will be added to it.
                </span>
              )}
            </>
          ) : linkMode === 'block' ? (
            <NodeSelector
              trigger="select"
              value={effectiveNodeId}
              searchMode="blocks"
              placeholder="Select a block..."
              searchPlaceholder="Search blocks..."
              initialSearchQuery={initialSearchQuery}
              onAdd={handleNodeAdd}
              onClearAll={handleNodeClear}
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
          <TextField
            id="link-label-input"
            value={label}
            onChange={e => setLabel(e.target.value)}
            autoComplete="off"
          />
          <span className="link-edit-modal__hint">
            {linkMode === 'url'
              ? 'Leave empty to use the URL'
              : 'Leave empty to use the node name'}
          </span>
        </div>
      </div>
    </Modal>
  );
}

export default LinkEditModal;
