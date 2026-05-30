/**
 * Scratchpad Component
 *
 * Floating panel backed by a real system Scratchpad page.
 * Blocks are persisted to the server under the Scratchpad page.
 * "Send all" moves blocks to a chosen destination page.
 * The backend clears all scratchpad blocks on app startup.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/core/Button';
import { NodeSelector } from '@/components/nodes/NodeSelector';
import { BlockList } from '@/components/blocks/BlockList';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { useTodayNote, usePages, useNodeByUuid, useMoveNode, useDeleteNode } from '@/hooks';
import { useContentSave, flushAllContentSaves } from '@/hooks/useContentSave';
import { queueContentSave } from '@/hooks/useBlockPersist';
import { useSettingsStore } from '@/stores';
import { generateUUID } from '@/utils/uuid';
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
  const [isPinned, setIsPinned] = useState(() => localStorage.getItem('notees-scratchpad-pinned') === 'true');
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [showDestinationPicker, setShowDestinationPicker] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const { quickAddDestination } = useSettingsStore();
  const moveNodeMutation = useMoveNode();
  const deleteNode = useDeleteNode();
  const { handleContentChange: saveContent } = useContentSave();

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
  // Don't count a single empty block (auto-created placeholder)
  const meaningfulCount = childCount === 1 && !scratchpadPage?.children?.[0]?.name ? 0 : childCount;
  const hasContent = childCount > 0;

  // Auto-create an empty block when scratchpad is empty so users can start typing immediately.
  // We create via the runtime (not direct API) so the block appears instantly and is focused.
  // useBlockPersist (active BlockEditor singleton) handles background persistence.
  const autoCreatedRef = useRef(false);
  const didCheckOnMountRef = useRef(false);
  useEffect(() => {
    if (!scratchpadPage) return;
    if (childCount > 0) {
      autoCreatedRef.current = false;
      return;
    }
    if (autoCreatedRef.current) return;

    const runtime = getNodeGraphRuntime();
    runtime.registerParentServerId(scratchpadPage.uuid, scratchpadPage.id);

    if (!didCheckOnMountRef.current) {
      didCheckOnMountRef.current = true;
      if (runtime.getChildren(scratchpadPage.uuid).length > 0) {
        autoCreatedRef.current = true;
        return;
      }
    }

    autoCreatedRef.current = true;
    const blockId = generateUUID();
    runtime.applyIntent({
      type: 'create_block',
      parentId: scratchpadPage.uuid,
      afterBlockId: null,
      blockId,
      contentAST: [],
    });
    runtime.requestFocus(blockId);
  }, [scratchpadPage, childCount]);

  useEffect(() => {
    onEntryCountChange?.(meaningfulCount);
  }, [meaningfulCount, onEntryCountChange]);

  const handleContentChange = useCallback((blockId: string, content: string) => {
    // Bridge block UUID → numeric serverId and persist via useContentSave
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    if (graphNode?.serverId != null) {
      saveContent(graphNode.serverId, content);
    } else if (graphNode) {
      // Block not yet persisted — queue for when serverId arrives
      queueContentSave(blockId, content);
    }

    // Update entry count
    if (!scratchpadPage?.uuid) return;
    const children = runtime.getChildren(scratchpadPage.uuid);
    const count = children.length === 1 && !children[0]?.name ? 0 : children.length;
    onEntryCountChange?.(count);
  }, [onEntryCountChange, scratchpadPage, saveContent]);

  const handleSendAll = useCallback(async () => {
    if (!destinationPage || !scratchpadPage || isSending) return;

    // Flush any pending debounced content saves before moving blocks,
    // so typed content is persisted to the server before the move.
    flushAllContentSaves();

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

  const handleSendAllRef = useRef(handleSendAll);
  useEffect(() => {
    handleSendAllRef.current = handleSendAll;
  });

  const handleClearAll = useCallback(async () => {
    if (!scratchpadPage?.children?.length) return;
    flushAllContentSaves();
    for (const child of scratchpadPage.children) {
      await deleteNode.mutateAsync(child.id);
    }
    onEntryCountChange?.(0);
  }, [scratchpadPage, deleteNode, onEntryCountChange]);

  // Ctrl+Enter when panel is open and focused sends all blocks
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        const active = document.activeElement;
        if (containerRef.current?.contains(active)) {
          e.preventDefault();
          handleSendAllRef.current();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const handleAddBlock = useCallback(() => {
    if (!scratchpadPage) return;
    const runtime = getNodeGraphRuntime();
    runtime.registerParentServerId(scratchpadPage.uuid, scratchpadPage.id);
    const children = runtime.getChildren(scratchpadPage.uuid);
    const blockId = generateUUID();
    runtime.applyIntent({
      type: 'create_block',
      parentId: scratchpadPage.uuid,
      afterBlockId: children.length > 0 ? children[children.length - 1].blockId : null,
      blockId,
      contentAST: [],
    });
    runtime.requestFocus(blockId);
  }, [scratchpadPage]);

  const handleDestinationSelect = useCallback((node: ApiNode) => {
    setCustomDestination(node);
    setShowDestinationPicker(false);
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
        <span className="scratchpad-title">Scratchpad{meaningfulCount > 0 ? ` (${meaningfulCount})` : ''}</span>
        <div className="scratchpad-actions">
          <Button
            className="scratchpad-btn"
            icon="mdi mdi-delete-sweep"
            variant="ghost"
            size="sm"
            onClick={handleClearAll}
            title="Clear all"
          />
          <Button
            className="scratchpad-btn"
            icon={isPinned ? "mdi mdi-pin" : "mdi mdi-pin-off"}
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
          <BlockList
            nodes={scratchpadPage.children ?? []}
            onContentChange={handleContentChange}
          />
        )}
        <div className="scratchpad-add-block">
          <Button icon={"mdi mdi-plus"} onClick={handleAddBlock} className="add-block-btn" title="Add block" size="sm" variant="ghost">
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
              icon={"mdi mdi-send"}
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

