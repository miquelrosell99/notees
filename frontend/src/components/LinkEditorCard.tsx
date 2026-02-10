/**
 * LinkEditorCard — Unified floating card for editing inline links.
 *
 * Two modes:
 *   - 'node'  — picks a node via SuggestionPopup dropdown + optional custom text
 *   - 'url'   — plain URL text field + display text
 *
 * Used by both ASTBlockContent (display mode) and ASTBlockEditor (edit mode)
 * to edit inline node links and external links.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import Icon from '@mdi/react';
import { mdiTrashCanOutline } from '@mdi/js';
import { Card } from './core/Card';
import { TextField } from './core/TextField';
import { Button } from './core/Button';
import { SuggestionPopup } from './SuggestionPopup';
import { useNode } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import type { Node } from '@/types';
import './LinkEditorCard.css';

// ─── Node link mode ────────────────────────────────────────────────

export interface LinkEditorNodeProps {
  mode: 'node';
  /** Current target node ID (from node_link.target_id), null if unknown */
  currentNodeId: number | null;
  /** Current custom display text (null = use node name) */
  currentCustomName: string | null;
  /** Link UUID for saving custom name */
  linkUuid: string;
  /** Position of the card */
  position: { top: number; left: number };
  /** Called when the user confirms changes. Returns newNodeUuid (for AST link_id) + newCustomName. */
  onSave: (linkUuid: string, newNodeId: number, newNodeUuid: string, newCustomName: string | null) => void;
  /** Called when the user deletes the link */
  onDelete: () => void;
  /** Called when the user cancels or clicks outside */
  onClose: () => void;
}

// ─── External link mode ────────────────────────────────────────────

export interface LinkEditorUrlProps {
  mode: 'url';
  /** Current URL */
  currentUrl: string;
  /** Current display text */
  currentText: string;
  /** Position of the card */
  position: { top: number; left: number };
  /** Called when the user confirms */
  onSave: (url: string, displayText: string) => void;
  /** Called when the user deletes the link */
  onDelete: () => void;
  /** Called when the user cancels or clicks outside */
  onClose: () => void;
}

export type LinkEditorCardProps = LinkEditorNodeProps | LinkEditorUrlProps;

export function LinkEditorCard(props: LinkEditorCardProps) {
  const { position, onClose, onDelete } = props;
  const cardRef = useRef<HTMLDivElement>(null);

  // Click outside to close
  useEffect(() => {
    // Delay setup to avoid closing from the same event that opened the card
    const timeoutId = setTimeout(() => {
      const handleMouseDown = (e: MouseEvent) => {
        if (cardRef.current && !cardRef.current.contains(e.target as globalThis.Node)) {
          // Don't close if clicking inside the suggestion popup
          const target = e.target as HTMLElement;
          if (target.closest('.suggestion-popup')) return;
          onClose();
        }
      };
      document.addEventListener('mousedown', handleMouseDown, true);
      
      // Store the handler for cleanup
      (timeoutId as any).handler = handleMouseDown;
    }, 0);
    
    return () => {
      clearTimeout(timeoutId);
      if ((timeoutId as any).handler) {
        document.removeEventListener('mousedown', (timeoutId as any).handler, true);
      }
    };
  }, [onClose]);

  return (
    <div
      ref={cardRef}
      className="link-editor-card"
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        zIndex: 1000,
      }}
      onClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
      onFocus={e => e.stopPropagation()}
    >
      <Card elevation="high" padding paddingSize="md" radius="md">
        <div className="link-editor-card__header">Edit Link</div>

        {props.mode === 'node' ? (
          <NodeLinkFields {...props} />
        ) : (
          <UrlLinkFields {...props} />
        )}

        <div className="link-editor-card__footer">
          <button
            className="link-editor-card__delete-btn"
            onClick={onDelete}
            title="Delete link"
            type="button"
          >
            <Icon path={mdiTrashCanOutline} size={0.72} />
          </button>
        </div>
      </Card>
    </div>
  );
}

// ─── Node link fields ──────────────────────────────────────────────

function NodeLinkFields({
  currentNodeId,
  currentCustomName,
  linkUuid,
  onSave,
  onClose,
}: LinkEditorNodeProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(currentNodeId);
  const [selectedNodeUuid, setSelectedNodeUuid] = useState<string | null>(null);
  const [customName, setCustomName] = useState(currentCustomName || '');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Look up the currently selected node for display
  const { data: selectedNode } = useNode(selectedNodeId);

  const selectedNodeName = useMemo(() => {
    if (!selectedNode) return null;
    return nodeNameToText(selectedNode.name) || (selectedNode.is_page ? '[Untitled Page]' : '[Empty Block]');
  }, [selectedNode]);

  const canConfirm = !!selectedNode;

  const handleSelectNode = useCallback((node: Node) => {
    setSelectedNodeId(node.id);
    setSelectedNodeUuid(node.uuid);
    setSearchQuery('');
    setShowSuggestions(false);
  }, []);

  const handleConfirm = useCallback(() => {
    if (!canConfirm || !selectedNodeId) return;
    // Prefer stored uuid from selection, fall back to node's uuid from query
    const uuid = selectedNodeUuid || selectedNode?.uuid || '';
    const trimmedName = customName.trim();
    onSave(linkUuid, selectedNodeId, uuid, trimmedName || null);
  }, [canConfirm, selectedNodeId, selectedNodeUuid, selectedNode, customName, linkUuid, onSave]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (showSuggestions) {
        setShowSuggestions(false);
      } else {
        onClose();
      }
      e.preventDefault();
    }
  }, [showSuggestions, onClose]);

  return (
    <>
      <div className="link-editor-card__field">
        <label className="link-editor-card__label">Link target</label>
        {selectedNode && (
          <div className="link-editor-card__selected-node" onClick={() => {
            setSelectedNodeId(null);
            setSelectedNodeUuid(null);
            setShowSuggestions(true);
            // Focus the search input after render
            setTimeout(() => searchInputRef.current?.focus(), 0);
          }}>
            <span className="link-editor-card__selected-node-name">{selectedNodeName}</span>
            <span className="link-editor-card__selected-node-change">Change</span>
          </div>
        )}
        {!selectedNode && (
          <>
            <input
              ref={searchInputRef}
              className="link-editor-card__search-input"
              type="text"
              value={searchQuery}
              onChange={e => {
                setSearchQuery(e.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              onKeyDown={handleKeyDown}
              placeholder="Search for a page or block…"
              autoFocus
            />
            {showSuggestions && (
              <SuggestionPopup
                isOpen={showSuggestions}
                query={searchQuery}
                type="link"
                position={{ top: 0, left: 0 }}
                onSelect={handleSelectNode}
                onClose={() => setShowSuggestions(false)}
              />
            )}
          </>
        )}
      </div>

      <div className="link-editor-card__field">
        <TextField
          label="Display text"
          value={customName}
          onChange={e => setCustomName(e.target.value)}
          placeholder={selectedNodeName || 'Custom text (optional)'}
          onKeyDown={handleKeyDown}
        />
      </div>

      <div className="link-editor-card__actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleConfirm}
          disabled={!canConfirm}
        >
          Save
        </Button>
      </div>
    </>
  );
}

// ─── URL link fields ───────────────────────────────────────────────

function UrlLinkFields({
  currentUrl,
  currentText,
  onSave,
  onClose,
}: LinkEditorUrlProps) {
  const [url, setUrl] = useState(currentUrl);
  const [displayText, setDisplayText] = useState(currentText);

  const canConfirm = url.trim().length > 0;

  const handleConfirm = useCallback(() => {
    if (!canConfirm) return;
    onSave(url.trim(), displayText.trim());
  }, [canConfirm, url, displayText, onSave]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canConfirm) {
      e.preventDefault();
      handleConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [canConfirm, handleConfirm, onClose]);

  return (
    <>
      <div className="link-editor-card__field">
        <TextField
          label="URL"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://…"
          autoFocus
          onKeyDown={handleKeyDown}
        />
      </div>

      <div className="link-editor-card__field">
        <TextField
          label="Display text"
          value={displayText}
          onChange={e => setDisplayText(e.target.value)}
          placeholder="Link text"
          onKeyDown={handleKeyDown}
        />
      </div>

      <div className="link-editor-card__actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleConfirm}
          disabled={!canConfirm}
        >
          Save
        </Button>
      </div>
    </>
  );
}
