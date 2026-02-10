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
import { mdiTrashCanOutline, mdiWeb, mdiFileDocumentOutline } from '@mdi/js';
import { Card } from './core/Card';
import { TextField } from './core/TextField';
import { Button } from './core/Button';
import { Separator } from './core/Separator';
import { SuggestionPopup } from './SuggestionPopup';
import { useNode, useCreateNode, usePageClass } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import type { Node } from '@/types';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
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
  /** Called when user toggles to URL mode */
  onModeToggle?: (mode: 'url') => void;
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
  /** Called when user toggles to node mode */
  onModeToggle?: (mode: 'node') => void;
}

export type LinkEditorCardProps = LinkEditorNodeProps | LinkEditorUrlProps;

export function LinkEditorCard(props: LinkEditorCardProps) {
  const { position, onClose, onDelete } = props;
  const cardRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(false);
  const [canConfirm, setCanConfirm] = useState(false);
  const confirmRef = useRef<(() => void) | null>(null);

  // Handle mode toggle
  const handleModeToggle = useCallback(() => {
    if (props.mode === 'node') {
      const nodeProps = props as LinkEditorNodeProps;
      nodeProps.onModeToggle?.('url');
    } else {
      const urlProps = props as LinkEditorUrlProps;
      urlProps.onModeToggle?.('node');
    }
  }, [props]);

  // Click outside to close — delay activation so the triggering click doesn't close us
  useEffect(() => {
    readyRef.current = false;
    const frameId = requestAnimationFrame(() => {
      readyRef.current = true;
    });

    const handleMouseDown = (e: MouseEvent) => {
      if (!readyRef.current) return;
      if (cardRef.current && !cardRef.current.contains(e.target as globalThis.Node)) {
        const target = e.target as HTMLElement;
        if (target.closest('.suggestion-popup')) return;
        if (target.closest('.link-editor-card')) return;
        onClose();
      }
    };

    document.addEventListener('mousedown', handleMouseDown);

    return () => {
      cancelAnimationFrame(frameId);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [onClose]);

  return (
    <div
      ref={cardRef}
      className="link-editor-card"
      style={{
        position: 'absolute',
        top: position.top,
        left: position.left,
        zIndex: 1000,
      }}
      onClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
      onFocus={e => e.stopPropagation()}
    >
      <Card elevation="high" padding paddingSize="md" radius="md">
        {props.mode === 'node' ? (
          <NodeLinkFields {...(props as LinkEditorNodeProps)} onCanConfirmChange={setCanConfirm} confirmRef={confirmRef} />
        ) : (
          <UrlLinkFields {...(props as LinkEditorUrlProps)} onCanConfirmChange={setCanConfirm} confirmRef={confirmRef} />
        )}

        <Separator orientation="horizontal" spacing="sm" />

        <div className="link-editor-card__footer">
          <div className="link-editor-card__footer-left">
            <button
              className="link-editor-card__mode-toggle"
              onClick={handleModeToggle}
              title={props.mode === 'node' ? 'Switch to URL link' : 'Switch to page link'}
              type="button"
            >
              <Icon path={props.mode === 'node' ? mdiWeb : mdiFileDocumentOutline} size={0.72} />
            </button>
            <button
              className="link-editor-card__delete-btn"
              onClick={onDelete}
              title="Delete link"
              type="button"
            >
              <Icon path={mdiTrashCanOutline} size={0.72} />
            </button>
          </div>
          <div className="link-editor-card__footer-actions">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => confirmRef.current?.()}
              disabled={!canConfirm}
            >
              Save
            </Button>
          </div>
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
  onCanConfirmChange,
  confirmRef,
}: LinkEditorNodeProps & {
  onCanConfirmChange: (v: boolean) => void;
  confirmRef: React.MutableRefObject<(() => void) | null>;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(currentNodeId);
  const [selectedNodeUuid, setSelectedNodeUuid] = useState<string | null>(null);
  const [customName, setCustomName] = useState(currentCustomName || '');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Mutations for creating nodes
  const createNodeMutation = useCreateNode();
  const { pageClass } = usePageClass();
  const queryClient = useQueryClient();

  // Look up the currently selected node for display
  const { data: selectedNode } = useNode(selectedNodeId);

  const selectedNodeName = useMemo(() => {
    if (!selectedNode) return null;
    return nodeNameToText(selectedNode.name) || (selectedNode.is_page ? '[Untitled Page]' : '[Empty Block]');
  }, [selectedNode]);

  const canConfirm = !!selectedNode;

  // Expose canConfirm and handleConfirm to the parent
  useEffect(() => {
    onCanConfirmChange(canConfirm);
  }, [canConfirm, onCanConfirmChange]);

  const handleSelectNode = useCallback((node: Node) => {
    setSelectedNodeId(node.id);
    setSelectedNodeUuid(node.uuid);
    setSearchQuery('');
    setShowSuggestions(false);
  }, []);

  // Handle creating a new page from the suggestion popup
  const handleCreateNode = useCallback(async (name: string, _keepInline: boolean) => {
    if (!pageClass) return;
    
    try {
      const newNode = await createNodeMutation.mutateAsync({
        name,
        classes: [pageClass.id],
      });
      
      // Invalidate caches to ensure the new node is visible
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      
      // Select the newly created node
      handleSelectNode(newNode);
    } catch (error) {
      console.error('Failed to create node from link editor:', error);
    }
  }, [pageClass, createNodeMutation, queryClient, handleSelectNode]);

  const handleConfirm = useCallback(() => {
    if (!canConfirm || !selectedNodeId) return;
    // Prefer stored uuid from selection, fall back to node's uuid from query
    const uuid = selectedNodeUuid || selectedNode?.uuid || '';
    const trimmedName = customName.trim();
    onSave(linkUuid, selectedNodeId, uuid, trimmedName || null);
  }, [canConfirm, selectedNodeId, selectedNodeUuid, selectedNode, customName, linkUuid, onSave]);

  // Expose confirm handler to parent
  useEffect(() => {
    confirmRef.current = handleConfirm;
    return () => { confirmRef.current = null; };
  }, [handleConfirm, confirmRef]);

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
                onCreate={handleCreateNode}
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
    </>
  );
}

// ─── URL link fields ───────────────────────────────────────────────

function UrlLinkFields({
  currentUrl,
  currentText,
  onSave,
  onClose,
  onCanConfirmChange,
  confirmRef,
}: LinkEditorUrlProps & {
  onCanConfirmChange: (v: boolean) => void;
  confirmRef: React.MutableRefObject<(() => void) | null>;
}) {
  const [url, setUrl] = useState(currentUrl);
  const [displayText, setDisplayText] = useState(currentText);

  const canConfirm = url.trim().length > 0;

  // Expose canConfirm and handleConfirm to the parent
  useEffect(() => {
    onCanConfirmChange(canConfirm);
  }, [canConfirm, onCanConfirmChange]);

  const handleConfirm = useCallback(() => {
    if (!canConfirm) return;
    onSave(url.trim(), displayText.trim());
  }, [canConfirm, url, displayText, onSave]);

  // Expose confirm handler to parent
  useEffect(() => {
    confirmRef.current = handleConfirm;
    return () => { confirmRef.current = null; };
  }, [handleConfirm, confirmRef]);

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
    </>
  );
}
