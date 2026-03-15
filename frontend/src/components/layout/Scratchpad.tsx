/**
 * Scratchpad Component
 *
 * Ephemeral floating panel for quick capture (cleared on page reload).
 * Uses BlockEditor in draft mode for multi-level outliner editing.
 * "Send all" sends top-level blocks (with children) to a chosen destination page.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { mdiPin, mdiPinOff, mdiSend, mdiPlus } from '@mdi/js';
import { Button } from '../core/Button';
import { NodeSelector } from '../nodes/NodeSelector';
import { BlockEditor } from '@/editor/BlockEditor';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { serializeContentAST } from '@/editor/editorConfig';
import { useTodayNote, usePages, useCreateNode } from '@/hooks';
import { useSettingsStore } from '@/stores';
import type { GraphNode, ContentAST } from '@/runtime/types';
import type { Node as ApiNode } from '@/types';
import './Scratchpad.css';

/** Stable virtual root ID for the scratchpad draft tree */
const SCRATCHPAD_ROOT_ID = '__scratchpad-root__';

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
  const [hasContent, setHasContent] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [showDestinationPicker, setShowDestinationPicker] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const { quickAddDestination } = useSettingsStore();
  const createNodeMutation = useCreateNode();

  // Get destination pages
  const { data: todayNote } = useTodayNote();
  const { data: allPages } = usePages();
  const inboxPage = allPages?.find(p => p.name === 'Inbox');
  const defaultDestination = quickAddDestination === 'today' ? todayNote : inboxPage;

  // Custom destination override (when user picks via NodeSelector)
  const [customDestination, setCustomDestination] = useState<ApiNode | null>(null);
  const destinationPage = customDestination ?? defaultDestination;

  // Seed the runtime with an empty first block under the virtual root
  const initialBlockId = useRef(crypto.randomUUID());
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;

    const runtime = getNodeGraphRuntime();
    const emptyAST: ContentAST = [{ children: [{ text: '' }] }];

    const graphNode: GraphNode = {
      blockId: initialBlockId.current,
      parentId: SCRATCHPAD_ROOT_ID,
      orderIndex: 0,
      nodeType: 'block',
      contentAST: emptyAST,
      collapsed: false,
      isDeleted: false,
      isPage: false,
      classIds: [],
      tagIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      hasServerChildren: false,
    };

    runtime.upsertNodes([graphNode]);
  }, []);

  // Clean up draft blocks from runtime on unmount
  useEffect(() => {
    return () => {
      const runtime = getNodeGraphRuntime();
      const children = runtime.getChildren(SCRATCHPAD_ROOT_ID);
      if (children.length > 0) {
        const allIds = [
          ...children.map(b => b.blockId),
          ...children.flatMap(b => runtime.getDescendants(b.blockId).map(d => d.blockId)),
        ];
        runtime.removeNodes(allIds);
      }
    };
  }, []);

  // Track content changes
  const handleContentChange = useCallback((_blockId: string, _content: string) => {
    const runtime = getNodeGraphRuntime();
    const children = runtime.getChildren(SCRATCHPAD_ROOT_ID);
    const count = children.filter(child => {
      const content = serializeContentAST(child.contentAST);
      return content && content !== '' && content !== '[]' && content !== '[{"children":[{"text":""}]}]';
    }).length;
    setHasContent(count > 0);
    onEntryCountChange?.(count);
  }, [onEntryCountChange]);

  // Recursively create blocks preserving hierarchy
  const createBlockTree = useCallback(async (
    parentServerId: number,
    children: GraphNode[],
  ) => {
    for (const child of children) {
      const content = serializeContentAST(child.contentAST);
      const isEmpty = !content || content === '' || content === '[]' || content === '[{"children":[{"text":""}]}]';

      const runtime = getNodeGraphRuntime();
      const grandchildren = runtime.getChildren(child.blockId);

      if (isEmpty && grandchildren.length === 0) continue;

      const created = await createNodeMutation.mutateAsync({
        name: isEmpty ? '' : content,
        parent_id: parentServerId,
        sequence: child.orderIndex,
      });

      if (grandchildren.length > 0) {
        await createBlockTree(created.id, grandchildren);
      }
    }
  }, [createNodeMutation]);

  const handleSendAll = useCallback(async () => {
    if (!destinationPage || isSending) return;

    setIsSending(true);
    try {
      const runtime = getNodeGraphRuntime();
      const topBlocks = runtime.getChildren(SCRATCHPAD_ROOT_ID);
      if (topBlocks.length === 0) return;

      await createBlockTree(destinationPage.id, topBlocks);

      // Clean up and reseed
      const allDraftIds = [
        ...topBlocks.map(b => b.blockId),
        ...topBlocks.flatMap(b => runtime.getDescendants(b.blockId).map(d => d.blockId)),
      ];
      runtime.removeNodes(allDraftIds);

      // Reseed with an empty block
      const newBlockId = crypto.randomUUID();
      const emptyAST: ContentAST = [{ children: [{ text: '' }] }];
      runtime.upsertNodes([{
        blockId: newBlockId,
        parentId: SCRATCHPAD_ROOT_ID,
        orderIndex: 0,
        nodeType: 'block',
        contentAST: emptyAST,
        collapsed: false,
        isDeleted: false,
        isPage: false,
        classIds: [],
        tagIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
        hasServerChildren: false,
      }]);

      setHasContent(false);
      onEntryCountChange?.(0);
    } finally {
      setIsSending(false);
    }
  }, [destinationPage, isSending, createBlockTree, onEntryCountChange]);

  const handleAddBlock = useCallback(() => {
    const runtime = getNodeGraphRuntime();
    const children = runtime.getChildren(SCRATCHPAD_ROOT_ID);
    const newBlockId = crypto.randomUUID();
    const lastChild = children.length > 0
      ? children.reduce((a, b) => (a.orderIndex >= b.orderIndex ? a : b))
      : null;

    runtime.requestFocus(newBlockId);
    runtime.applyIntent({
      type: 'create_block',
      parentId: SCRATCHPAD_ROOT_ID,
      afterBlockId: lastChild?.blockId ?? null,
      blockId: newBlockId,
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
    });
    runtime.flushEvents();
  }, []);

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

  // Close on Escape when no block is being edited or selected
  useEffect(() => {
    if (!isOpen && !isPinned) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!containerRef.current) return;

      // If another handler already dealt with this ESC (e.g. editor clearing selection), skip
      if (e.defaultPrevented) return;

      const active = document.activeElement;

      // Only handle ESC if focus is inside the scratchpad (or on body/nothing)
      const focusInside = active && containerRef.current.contains(active);
      const noFocus = !active || active === document.body;
      if (!focusInside && !noFocus) return;

      // If a contenteditable inside the scratchpad is focused, let the editor handle it
      if (focusInside && (active as HTMLElement).isContentEditable) return;

      // If any blocks are selected, let the editor handle it
      if (containerRef.current.querySelector('.node-block--selected')) return;

      // Nothing active — close the scratchpad
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

  if (!isOpen && !isPinned) return null;
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
        <BlockEditor
          editorId="scratchpad"
          rootBlockId={SCRATCHPAD_ROOT_ID}
          mode="list"
          draftMode
          placeholder="What's on your mind?"
          onContentChange={handleContentChange}
          hideProperties
        />
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