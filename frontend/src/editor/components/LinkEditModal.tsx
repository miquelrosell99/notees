/**
 * LinkEditModal — Modal for editing inline node link pills.
 *
 * Opens when clicking a pill in edit mode. Allows:
 * - Changing the link target (search & select another node)
 * - Setting a custom display label (stored in node_link.name)
 *
 * Uses the existing Modal core component and useSearch hook.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { mdiMagnify } from '@mdi/js';
import Icon from '@mdi/react';
import { Modal } from '@/components/core/Modal';
import { Button } from '@/components/core/Button';
import { NodeIcon } from '@/components/core/icons';
import { useSearch, useNodeByUuid } from '@/hooks/useNodeQueries';
import { useClasses } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { parseLinkId } from '@/lib/astBuilder';
import type { Node } from '@/types/api';
import './LinkEditModal.css';

export interface LinkEditModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Current compound link ID (nodeUuid:linkUuid) */
  linkId: string;
  /** Current ref type */
  refType: 'node' | 'class';
  /** Current custom label (from node_link.name) */
  currentLabel?: string | null;
  /** Called when saving changes */
  onSave: (result: LinkEditResult) => void;
  /** Called when closing without saving */
  onClose: () => void;
}

export interface LinkEditResult {
  /** New target node (null if unchanged) */
  targetNode: Node | null;
  /** Custom label (null to clear, undefined if unchanged) */
  label: string | null;
  /** Original link ID for reference */
  originalLinkId: string;
}

export function LinkEditModal({
  isOpen,
  linkId,
  currentLabel,
  onSave,
  onClose,
}: LinkEditModalProps) {
  const { nodeUuid } = parseLinkId(linkId);
  const { data: currentNode } = useNodeByUuid(nodeUuid);
  const { data: allClasses } = useClasses();

  // ─── State ─────────────────────────────────────────────────

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [label, setLabel] = useState(currentLabel ?? '');
  const [showSearch, setShowSearch] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);

  // Search results
  const { data: searchResults = [] } = useSearch(searchQuery);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSearchQuery('');
      setSelectedNode(null);
      setLabel(currentLabel ?? '');
      setShowSearch(false);
    }
  }, [isOpen, currentLabel]);

  // Focus search input when search is shown
  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  // ─── Derived values ────────────────────────────────────────

  const displayNode = selectedNode ?? currentNode;

  const currentNodeName = useMemo(() => {
    if (!displayNode) return '…';
    const text = nodeNameToText(displayNode.name);
    if (!text || text.trim() === '') {
      return displayNode.is_page ? '[Untitled Page]' : '[Empty Block]';
    }
    return text;
  }, [displayNode]);

  const effectiveIcon = useMemo(
    () => getEffectiveIcon(displayNode, allClasses),
    [displayNode, allClasses],
  );

  // Filter search results to exclude current node
  const filteredResults = useMemo(() => {
    const effectiveUuid = selectedNode?.uuid ?? nodeUuid;
    return searchResults.filter(n => n.uuid !== effectiveUuid);
  }, [searchResults, selectedNode, nodeUuid]);

  // ─── Handlers ──────────────────────────────────────────────

  const handleSelectNode = useCallback((node: Node) => {
    setSelectedNode(node);
    setShowSearch(false);
    setSearchQuery('');
  }, []);

  const handleSave = useCallback(() => {
    const trimmedLabel = label.trim();
    onSave({
      targetNode: selectedNode,
      label: trimmedLabel || null,
      originalLinkId: linkId,
    });
  }, [selectedNode, label, linkId, onSave]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !showSearch) {
      e.preventDefault();
      handleSave();
    }
  }, [showSearch, handleSave]);

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
        {/* Current target section */}
        <div className="link-edit-modal__section">
          <label className="link-edit-modal__label">Link Target</label>
          <div className="link-edit-modal__target">
            <div className="link-edit-modal__target-node">
              {effectiveIcon && (
                <NodeIcon
                  icon={effectiveIcon}
                  isPage={displayNode?.is_page ?? true}
                  size="sm"
                />
              )}
              <span className="link-edit-modal__target-name">
                {currentNodeName}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon={mdiMagnify}
              onClick={() => setShowSearch(!showSearch)}
              title="Change target node"
            >
              Change
            </Button>
          </div>

          {/* Inline node search */}
          {showSearch && (
            <div className="link-edit-modal__search">
              <div className="link-edit-modal__search-input-wrapper">
                <Icon path={mdiMagnify} size={0.7} className="link-edit-modal__search-icon" />
                <input
                  ref={searchInputRef}
                  type="text"
                  className="link-edit-modal__search-input"
                  placeholder="Search nodes…"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  autoComplete="off"
                />
              </div>
              {searchQuery.length > 0 && (
                <div className="link-edit-modal__search-results">
                  {filteredResults.length === 0 ? (
                    <div className="link-edit-modal__no-results">No results</div>
                  ) : (
                    filteredResults.slice(0, 10).map(node => (
                      <SearchResultItem
                        key={node.id}
                        node={node}
                        allClasses={allClasses}
                        onSelect={handleSelectNode}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Custom label section */}
        <div className="link-edit-modal__section">
          <label className="link-edit-modal__label" htmlFor="link-label-input">
            Custom Label
          </label>
          <input
            ref={labelInputRef}
            id="link-label-input"
            type="text"
            className="link-edit-modal__input"
            placeholder={currentNodeName}
            value={label}
            onChange={e => setLabel(e.target.value)}
            autoComplete="off"
          />
          <span className="link-edit-modal__hint">
            Leave empty to use the node name
          </span>
        </div>
      </div>
    </Modal>
  );
}

// ─── Internal search result item ─────────────────────────────────

function SearchResultItem({
  node,
  allClasses,
  onSelect,
}: {
  node: Node;
  allClasses: Node[] | undefined;
  onSelect: (node: Node) => void;
}) {
  const effectiveIcon = useMemo(
    () => getEffectiveIcon(node, allClasses),
    [node, allClasses],
  );

  const name = useMemo(() => {
    const text = nodeNameToText(node.name);
    if (!text || text.trim() === '') {
      return node.is_page ? '[Untitled Page]' : '[Empty Block]';
    }
    return text;
  }, [node]);

  return (
    <button
      type="button"
      className="link-edit-modal__result-item"
      onClick={() => onSelect(node)}
    >
      {effectiveIcon && (
        <NodeIcon icon={effectiveIcon} isPage={node.is_page} size="sm" />
      )}
      <span className="link-edit-modal__result-name">{name}</span>
    </button>
  );
}

export default LinkEditModal;
