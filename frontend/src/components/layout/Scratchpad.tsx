/**
 * Scratchpad Component
 *
 * Floating panel backed by a real system Scratchpad page.
 * Blocks are persisted to the server under the Scratchpad page.
 * "Send all" moves blocks to a chosen destination page.
 * The backend clears all scratchpad blocks on app startup.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { mdiPin, mdiPinOff, mdiSend, mdiPlus } from '@mdi/js';
import { Button } from '../core/Button';
import { NodeSelector } from '../nodes/NodeSelector';
import { BlockEditor } from '@/editor/BlockEditor';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { useTodayNote, usePages, useCreateNode, useNodeByUuid, useMoveNode } from '@/hooks';
import { useSettingsStore } from '@/stores';
import { SYSTEM_PAGE_UUIDS } from '@/constants/systemProperties';
import type { Node as ApiNode } from '@/types';
import './Scratchpad.css';

interface ScratchpadProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  onEntryCountChange?: (count: number) => void;
}

export function Scratchpad({ isOpen, onClose, anchorRef, onEntryCountChange }: ScratchpadProps) {
  const [isPinned, setIsPinned] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [showDestinationPicker, setShowDestinationPicker] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const { quickAddDestination } = useSettingsStore();
  const createNodeMutation = useCreateNode();
  const moveNodeMutation = useMoveNode();

  // Fetch the Scratchpad system page by its fixed UUID
  const { data: scratchpadPage } = useNodeByUuid(
    SYSTEM_PAGE_UUIDS.scratchpad,
    { include_children: true }
  );

  // Get destination pages
  const { data: todayNote } = useTodayNote();
  const { data: allPages } = usePages();
  const inboxPage = allPages?.find(p => p.name === 'Inbox');
  const defaultDestination = quickAddDestination === 'today' ? todayNote : inboxPage;

  // Custom destination override (when user picks via NodeSelector)
  const [customDestination, setCustomDestination] = useState<ApiNode | null>(null);
  const destinationPage = customDestination ?? defaultDestination;

  // Track content count from children
  const childCount = scratchpadPage?.children?.length ?? 0;
  const hasContent = childCount > 0;

  // Auto-create an empty block when scratchpad is empty so users can start typing immediately
  const autoCreatedRef = useRef(false);
  useEffect(() => {
    if (scratchpadPage && childCount === 0 && !autoCreatedRef.current && !createNodeMutation.isPending) {
      autoCreatedRef.current = true;
      createNodeMutation.mutate({
        name: '',
        parent_id: scratchpadPage.id,
      });
    }
    if (childCount > 0) {
      autoCreatedRef.current = false;
    }
  }, [scratchpadPage, childCount, createNodeMutation]);

  useEffect(() => {
    onEntryCountChange?.(childCount);
  }, [childCount, onEntryCountChange]);

  const handleContentChange = useCallback((_blockId: string, _content: string) => {
    // Content is auto-persisted by BlockEditor (not in draft mode)
    if (!scratchpadPage?.uuid) return;
    const runtime = getNodeGraphRuntime();
    const children = runtime.getChildren(scratchpadPage.uuid);
    onEntryCountChange?.(children.length);
  }, [onEntryCountChange, scratchpadPage?.uuid]);

  const handleSendAll = useCallback(async () => {
    if (!destinationPage || !scratchpadPage || isSending) return;

    setIsSending(true);
    try {
      const children = scratchpadPage.children ?? [];
      if (children.length === 0) return;

      for (const child of children) {
        await moveNodeMutation.mutateAsync({
          id: child.id,
          parentId: destinationPage.id,
        });
      }

      onEntryCountChange?.(0);
    } finally {
      setIsSending(false);
    }
  }, [destinationPage, scratchpadPage, isSending, moveNodeMutation, onEntryCountChange]);

  const handleAddBlock = useCallback(() => {
    if (!scratchpadPage) return;
    createNodeMutation.mutate({
      name: '',
      parent_id: scratchpadPage.id,
    });
  }, [scratchpadPage, createNodeMutation]);

  const handleDestinationSelect = useCallback((node: ApiNode) => {
    setCustomDestination(node);
    setShowDestinationPicker(false);
  }, []);

  // Load pinned state
  useEffect(() => {
    const pinnedState = localStorage.getItem('notees-scratchpad-pinned');
    if (pinnedState === 'true') {
      setIsPinned(true);
    }
  }, []);

  // Position below anchor button when opened
  useEffect(() => {
    if (isOpen && anchorRef?.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      const popupWidth = 360;
      const gap = 4;
      let left = rect.right - popupWidth;
      if (left < 8) left = 8;
      if (left + popupWidth > window.innerWidth - 8) {
        left = window.innerWidth - popupWidth - 8;
      }
      setPosition({ x: left, y: rect.bottom + gap });
    } else if (isOpen && !position) {
      setPosition({ x: 100, y: 100 });
    }
  }, [isOpen]);

  // Close on outside click when not pinned
  useEffect(() => {
    if (!isOpen || isPinned) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as globalThis.Node) &&
        (!anchorRef?.current || !anchorRef.current.contains(e.target as globalThis.Node))
      ) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, isPinned, onClose, anchorRef]);

  // Close on Escape when no block is being edited or selected (pinned prevents closing)
  useEffect(() => {
    if (!isOpen || isPinned) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!containerRef.current) return;

      if (e.defaultPrevented) return;

      const active = document.activeElement;

      const focusInside = active && containerRef.current.contains(active);
      const noFocus = !active || active === document.body;
      if (!focusInside && !noFocus) return;

      if (focusInside && (active as HTMLElement).isContentEditable) return;
      if (containerRef.current.querySelector('.node-block--selected')) return;

      e.preventDefault();
      e.stopPropagation();
      onClose();
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, isPinned, onClose]);

  const handleTogglePin = useCallback(() => {
    setIsPinned(prev => {
      localStorage.setItem('notees-scratchpad-pinned', String(!prev));
      return !prev;
    });
  }, []);

  // Dragging handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget || !position) return;
    setIsDragging(true);
    dragOffset.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
  }, [position]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newPos = {
        x: Math.max(0, Math.min(window.innerWidth - 360, e.clientX - dragOffset.current.x)),
        y: Math.max(0, Math.min(window.innerHeight - 200, e.clientY - dragOffset.current.y)),
      };
      setPosition(newPos);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, position]);

  if (!isOpen) return null;
  if (!position) return null;

  const destinationLabel = customDestination
    ? (customDestination.name ? (() => { try { const ast = JSON.parse(customDestination.name); return Array.isArray(ast) ? ast.map((b: { children?: { text?: string }[] }) => b.children?.map(c => c.text ?? '').join('') ?? '').join('') : customDestination.name; } catch { return customDestination.name; } })() : 'Untitled')
    : (quickAddDestination === 'today' ? "Today's page" : 'Inbox');

  const canSend = destinationPage && hasContent && !isSending;

  return (
    <div
      ref={containerRef}
      className={`scratchpad ${isDragging ? 'dragging' : ''} ${isPinned ? 'pinned' : ''}`}
      style={{ left: position.x, top: position.y }}
    >
      <div className="scratchpad-header" onMouseDown={handleMouseDown}>
        <span className="scratchpad-title">Scratchpad</span>
        <div className="scratchpad-actions">
          <Button
            className="scratchpad-btn"
            icon={isPinned ? mdiPin : mdiPinOff}
            variant="ghost"
            size="sm"
            active={isPinned}
            onClick={handleTogglePin}
            title={isPinned ? 'Unpin' : 'Pin'}
          />
        </div>
      </div>

      <div className="scratchpad-content">
        {scratchpadPage && (
          <BlockEditor
            editorId="scratchpad"
            nodes={scratchpadPage.children ?? []}
            pageId={scratchpadPage.id}
            pageUuid={scratchpadPage.uuid}
            mode="list"
            onContentChange={handleContentChange}
            hideProperties
          />
        )}
        <div className="scratchpad-add-block">
          <Button icon={mdiPlus} onClick={handleAddBlock} className="add-block-btn" title="Add block" size="sm" variant="ghost">
            Add block
          </Button>
        </div>
      </div>

      <div className="scratchpad-footer">
        {showDestinationPicker ? (
          <div className="scratchpad-destination-picker">
            <NodeSelector
              trigger="inline"
              searchMode="pages"
              onAdd={handleDestinationSelect}
              searchPlaceholder="Pick destination page..."
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDestinationPicker(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="scratchpad-send-row">
            <button
              className="scratchpad-destination-hint"
              onClick={() => setShowDestinationPicker(true)}
              title="Change destination"
            >
              → {destinationLabel}
            </button>
            <Button
              icon={mdiSend}
              variant="primary"
              size="sm"
              onClick={handleSendAll}
              disabled={!canSend}
              title="Send all"
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default Scratchpad;
