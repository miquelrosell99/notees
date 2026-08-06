/**
 * Scratchpad Component
 *
 * Floating panel for transient notes. Blocks live only in component state and
 * are cleared on every page reload. The trailing ghost block from the normal
 * list view provides the empty-state entry point, so no real empty block is
 * created upfront.
 *
 * "Send all" realizes the transient blocks by creating them under the chosen
 * destination page.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { NodeSelector, BlockList } from '@/features/content';

import { useTodayNote, usePages, useNodeByUuid, useCreateNode, useDeleteNode } from '@/features/content';
import { flushAllContentSaves } from '@/features/editor';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useOverlaySurface } from '@/hooks/useOverlaySurface';
import { useSettingsStore } from '@/stores';
import { SYSTEM_PAGE_UUIDS } from '@/constants/systemProperties';
import type { Node as ApiNode } from '@/types';
import { uuidv7 } from '@/core/uuid';
import './Scratchpad.css';
import { useEditorFocusStore } from '@/stores/editorFocusStore';


interface ScratchpadProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  onEntryCountChange?: (count: number) => void;
}

const EMPTY_BLOCK_AST = '[{"type":"paragraph","children":[{"type":"text","text":""}]}]';

function createEmptyTransientBlock(parentUuid: string): ApiNode {
  return {
    uuid: uuidv7(),
    name: EMPTY_BLOCK_AST,
    icon: null,
    color: null,
    parent_uuid: parentUuid,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: false,
    is_deleted: false,
    has_children: false,
    children: [],
    create_date: new Date().toISOString(),
    write_date: new Date().toISOString(),
    classes_uuid: [],
    tags_uuid: [],
    properties_uuid: {},
  } as ApiNode;
}

export function Scratchpad({ isOpen, onClose, anchorRef, onEntryCountChange }: ScratchpadProps) {
  const [isPinned, setIsPinned] = useState(() => localStorage.getItem('notees-scratchpad-pinned') === 'true');
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [showDestinationPicker, setShowDestinationPicker] = useState(false);
  const [transientBlocks, setTransientBlocks] = useState<ApiNode[]>([]);
  const dragOffset = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // Register with the global overlay stack so Escape closes the scratchpad
  // regardless of where DOM focus is.
  useOverlaySurface({
    type: 'popup',
    enabled: isOpen,
    onClose,
  });

  // Trap focus inside the scratchpad while it is open and return focus on close.
  // Escape handling is owned by the global overlay stack.
  useFocusTrap(containerRef, {
    enabled: isOpen,
    onEscape: undefined,
    restoreFocus: true,
  });

  const quickAddDestination = useSettingsStore((s) => s.quickAddDestination);
  const createNode = useCreateNode();
  const deleteNode = useDeleteNode();

  // Fetch the Scratchpad system page by its fixed UUID. We only need the page
  // itself (as the parent reference for transient blocks), not its children.
  const { data: scratchpadPage } = useNodeByUuid(SYSTEM_PAGE_UUIDS.scratchpad);

  // The scratchpad is now transient-only. Any blocks that were previously
  // persisted under the Scratchpad page are stale and should be removed once
  // per page load so the popup and the page itself stay empty on reload.
  const cleanedUpRef = useRef(false);
  useEffect(() => {
    if (!scratchpadPage || cleanedUpRef.current) return;
    const persisted = scratchpadPage.children ?? [];
    if (persisted.length === 0) return;

    cleanedUpRef.current = true;
    for (const child of persisted) {
      deleteNode.mutate(child.uuid);
    }
  }, [scratchpadPage, deleteNode]);

  // Get destination pages
  const { data: todayNote } = useTodayNote();
  const { data: allPages } = usePages();
  const inboxPage = allPages?.find((p) => p.name === 'Inbox');
  const defaultDestination = quickAddDestination === 'today' ? todayNote : inboxPage;

  // Custom destination override (when user picks via NodeSelector)
  const [customDestination, setCustomDestination] = useState<ApiNode | null>(null);
  const destinationPage = customDestination ?? defaultDestination;

  const meaningfulCount = transientBlocks.length;
  const hasContent = meaningfulCount > 0;

  useEffect(() => {
    onEntryCountChange?.(meaningfulCount);
  }, [meaningfulCount, onEntryCountChange]);

  const addTransientBlock = useCallback(
    (parentUuid: string) => {
      const newBlock = createEmptyTransientBlock(parentUuid);
      setTransientBlocks((prev) => [...prev, newBlock]);
      useEditorFocusStore.getState().setPendingFocus(newBlock.uuid);
      return newBlock;
    },
    [setTransientBlocks],
  );

  const handleGhostRealize = useCallback(() => {
    if (!scratchpadPage) return;
    addTransientBlock(scratchpadPage.uuid);
  }, [addTransientBlock, scratchpadPage]);

  const handleContentChange = useCallback(
    (blockId: string, content: string) => {
      setTransientBlocks((prev) =>
        prev.map((block) => (block.uuid === blockId ? { ...block, name: content } : block)),
      );
    },
    [setTransientBlocks],
  );

  const handleEnter = useCallback(
    (blockId: string) => {
      if (!scratchpadPage) return;
      const idx = transientBlocks.findIndex((b) => b.uuid === blockId);
      const newBlock = createEmptyTransientBlock(scratchpadPage.uuid);
      const insertAt = idx >= 0 ? idx + 1 : transientBlocks.length;
      const next = [...transientBlocks];
      next.splice(insertAt, 0, newBlock);
      setTransientBlocks(next);
      useEditorFocusStore.getState().setPendingFocus(newBlock.uuid);
    },
    [scratchpadPage, transientBlocks],
  );

  const handleBackspaceAtStart = useCallback(
    (blockId: string) => {
      const block = transientBlocks.find((b) => b.uuid === blockId);
      if (!block) return;
      // Only delete the block if it is empty.
      if (block.name !== '[]' && block.name !== EMPTY_BLOCK_AST) return;

      const idx = transientBlocks.findIndex((b) => b.uuid === blockId);
      if (idx <= 0) return;

      const prevId = transientBlocks[idx - 1]!.uuid;
      setTransientBlocks((prev) => prev.filter((b) => b.uuid !== blockId));
      useEditorFocusStore.getState().setPendingFocus(prevId);
    },
    [transientBlocks],
  );

  const handleSendAll = useCallback(async () => {
    if (!destinationPage || !scratchpadPage || isSending) return;

    // Flush any pending debounced content saves before sending blocks,
    // so typed content is captured by the transient state.
    await flushAllContentSaves();

    setIsSending(true);
    try {
      if (transientBlocks.length === 0) return;

      for (const block of transientBlocks) {
        await createNode.mutateAsync({
          name: block.name,
          parent_uuid: destinationPage.uuid,
        });
      }

      setTransientBlocks([]);
      onEntryCountChange?.(0);
    } finally {
      setIsSending(false);
    }
  }, [destinationPage, scratchpadPage, isSending, transientBlocks, createNode, onEntryCountChange]);

  const handleSendAllRef = useRef(handleSendAll);
  useEffect(() => {
    handleSendAllRef.current = handleSendAll;
  });

  const handleClearAll = useCallback(async () => {
    if (transientBlocks.length === 0) return;
    await flushAllContentSaves();
    setTransientBlocks([]);
    onEntryCountChange?.(0);
  }, [transientBlocks, onEntryCountChange]);

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
    addTransientBlock(scratchpadPage.uuid);
  }, [addTransientBlock, scratchpadPage]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handleTogglePin = useCallback(() => {
    setIsPinned((prev) => {
      localStorage.setItem('notees-scratchpad-pinned', String(!prev));
      return !prev;
    });
  }, []);

  // Dragging handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!position) return;
      setIsDragging(true);
      dragOffset.current = {
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      };
    },
    [position],
  );

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
    ? (customDestination.name
        ? (() => {
            try {
              const ast = JSON.parse(customDestination.name);
              return Array.isArray(ast)
                ? ast
                    .map(
                      (b: { children?: { text?: string }[] }) =>
                        b.children?.map((c) => c.text ?? '').join('') ?? '',
                    )
                    .join('')
                : customDestination.name;
            } catch {
              return customDestination.name;
            }
          })()
        : 'Untitled')
    : quickAddDestination === 'today'
      ? "Today's page"
      : 'Inbox';

  const canSend = destinationPage && hasContent && !isSending;

  return (
    <div
      ref={containerRef}
      className={`scratchpad ${isDragging ? 'dragging' : ''} ${isPinned ? 'pinned' : ''}`}
      style={{ left: position.x, top: position.y }}
    >
      <div className="scratchpad-header">
        <button
          type="button"
          className="scratchpad-drag-handle"
          aria-label="Drag to move scratchpad"
          onMouseDown={handleMouseDown}
          onKeyDown={(e) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
            e.preventDefault();
            setPosition((prev) => {
              if (!prev) return prev;
              const step = e.shiftKey ? 50 : 10;
              const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
              const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
              return {
                x: Math.max(0, Math.min(window.innerWidth - 360, prev.x + dx)),
                y: Math.max(0, Math.min(window.innerHeight - 200, prev.y + dy)),
              };
            });
          }}
        >
          <span className="scratchpad-title">
            Scratchpad{meaningfulCount > 0 ? ` (${meaningfulCount})` : ''}
          </span>
        </button>
        <div className="scratchpad-actions">
          <Button
            aria-label="Clear all"
            className="scratchpad-btn"
            icon="mdi mdi-delete-sweep"
            variant="ghost"
            size="sm"
            onClick={handleClearAll}
            title="Clear all"
          />
          <Button
            aria-label={isPinned ? 'Unpin' : 'Pin'}
            className="scratchpad-btn"
            icon={isPinned ? 'mdi mdi-pin' : 'mdi mdi-pin-off'}
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
            nodes={transientBlocks}
            onContentChange={handleContentChange}
            onEnter={handleEnter}
            onBackspaceAtStart={handleBackspaceAtStart}
            nodeUuid={scratchpadPage.uuid}
            showClasses={true}
            localOnly={true}
            onGhostRealize={handleGhostRealize}
          />
        )}
        <div className="scratchpad-add-block hover-reveal">
          <Button
            icon={'mdi mdi-plus'}
            onClick={handleAddBlock}
            className="add-block-btn"
            aria-label="Add block"
            title="Add block"
            size="sm"
            variant="ghost"
          >
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
            <Button variant="ghost" size="sm" onClick={() => setShowDestinationPicker(false)}>
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
              aria-label="Send all"
              icon={'mdi mdi-send'}
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
