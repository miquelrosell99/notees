/**
 * InlineTriggers — Custom-editor port of TriggerPlugin.
 *
 * Detects trigger characters (+, @, #, /) and opens the shared TriggerPopup.
 * The popup owns its own search input; only the trigger character is inserted
 * into the editor as a placeholder.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { flushSync } from 'react-dom';
import type { Node } from '@/types';
import { TriggerPopup, type TriggerPopupType } from '@/features/editor/editor/plugins/TriggerPopup';
import { DateRangePicker } from '@/features/properties/components/DateRangePicker';
import { generateUUID } from '@/utils/uuid';
import type { DateRangeValue } from '@/utils/dateRange';
import { getOperationRuntime } from '@/runtime';
import { getNode, getAllNodes } from '@/runtime/graphHelpers';
import { getRuntimeEventBus, applyRuntimeIntent } from '@/runtime/eventBus';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { flushAllContentSaves } from '@/hooks/contentSaveTracker';
import { getSlashCommand } from '@/plugins/core';
import { buildLinkId, nodeLink, dateRange as buildDateRangeNode } from '@/lib/astBuilder';
import {
  insertText,
  deleteRange,
  insertAtomicNode,
  astToUnits,
  getInlineChildren,
  offsetToPosition,
} from '../model/inlineEditorModel';
import type { InlineEditorState } from '../model/types';

interface PopupState {
  type: TriggerPopupType;
  position: { top: number; left: number; caretTop: number };
  context?: 'template' | 'embed';
  classFilters?: string[];
}

interface InlineTriggersProps {
  rootRef: React.RefObject<HTMLDivElement | null>;
  stateRef: React.MutableRefObject<InlineEditorState>;
  applyMutation: (mutator: (prev: InlineEditorState) => InlineEditorState) => void;
  blockId: string;
  onAddClass?: (blockServerId: string, classId: string) => void;
  onSlashCommand?: (commandId: string, blockServerId: string | undefined) => void;
  onTemplateInstantiate?: (templateNodeId: string, blockServerId: string | undefined) => void;
  templateClassFilters?: string[];
}

const TRIGGERS = ['+', '@', '#', '/'] as const;
type TriggerChar = typeof TRIGGERS[number];

function isTriggerChar(key: string): key is TriggerChar {
  return TRIGGERS.includes(key as TriggerChar);
}

function triggerType(key: TriggerChar): TriggerPopupType {
  switch (key) {
    case '+':
      return 'class';
    case '@':
      return 'link';
    case '#':
      return 'tag';
    case '/':
      return 'slash';
  }
}

function isValidTrigger(key: TriggerChar, prevChar: string | null): boolean {
  if (key === '/') {
    return prevChar === null || /\s/.test(prevChar);
  }
  return prevChar === null || /[^a-zA-Z0-9]/.test(prevChar);
}

function getCharBeforeOffset(state: InlineEditorState, offset: number): string | null {
  if (offset <= 0) return null;
  const units = astToUnits(getInlineChildren(state.ast));
  const pos = offsetToPosition(units, offset - 1);
  const unit = units[pos.unitIndex];
  if (!unit) return null;
  if (unit.type === 'atomic') {
    // Atomic nodes act as word boundaries.
    return ' ';
  }
  return unit.text[pos.innerOffset] ?? null;
}

function getCaretCoordinates(root: HTMLElement): { top: number; left: number; caretTop: number } {
  const rootRect = root.getBoundingClientRect();
  const fallback = {
    top: rootRect.bottom + window.scrollY,
    left: rootRect.left + window.scrollX,
    caretTop: rootRect.top + window.scrollY,
  };

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return fallback;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return fallback;

  const cloned = range.cloneRange();
  cloned.collapse(true);
  const rect = cloned.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return fallback;

  return {
    top: rect.bottom + window.scrollY,
    left: rect.left + window.scrollX,
    caretTop: rect.top + window.scrollY,
  };
}

export function InlineTriggers({
  rootRef,
  stateRef,
  applyMutation,
  blockId,
  onAddClass,
  onSlashCommand,
  onTemplateInstantiate,
  templateClassFilters,
}: InlineTriggersProps): JSX.Element | null {
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [dateRangePickerOpen, setDateRangePickerOpen] = useState(false);
  const popupOpenRef = useRef(false);
  const placeholderOffsetRef = useRef<number | null>(null);
  const blockServerIdRef = useRef<string | undefined>(undefined);
  const hadFocusBeforeRef = useRef(false);
  const selectionMadeRef = useRef(false);

  useEffect(() => {
    popupOpenRef.current = popup !== null;
  }, [popup]);

  // Track popup open state so the editor does not lose its active block state.
  useEffect(() => {
    if (popup) {
      useEditorFocusStore.getState().openPopup();
      return () => {
        useEditorFocusStore.getState().closePopup();
      };
    }
  }, [popup]);

  const resolveBlockServerId = useCallback(() => {
    const runtime = getOperationRuntime();
    const graphNode = getNode(runtime, blockId);
    blockServerIdRef.current = graphNode?.blockId;
  }, [blockId]);

  const openTrigger = useCallback(
    (key: TriggerChar, fromComposition = false) => {
      const root = rootRef.current;
      if (!root) return;

      resolveBlockServerId();
      const coords = getCaretCoordinates(root);
      hadFocusBeforeRef.current =
        root === document.activeElement || root.contains(document.activeElement);

      if (!fromComposition) {
        const start = (() => {
          const sel = stateRef.current.selection;
          if (sel.type === 'collapsed') return sel.offset;
          if (sel.type === 'range') return Math.min(sel.anchor, sel.focus);
          return sel.nodeIndex;
        })();
        // Insert trigger char at the current selection.
        applyMutation((prev) => insertText(prev, key));
        placeholderOffsetRef.current = start;
      } else {
        // Composition already inserted the trigger char; the cursor is after it.
        const sel = stateRef.current.selection;
        const offset = sel.type === 'collapsed' ? sel.offset : 0;
        placeholderOffsetRef.current = Math.max(0, offset - 1);
      }

      popupOpenRef.current = true;
      setPopup({ type: triggerType(key), position: coords });
    },
    [rootRef, stateRef, applyMutation, resolveBlockServerId],
  );

  const removePlaceholder = useCallback(() => {
    const offset = placeholderOffsetRef.current;
    if (offset === null) return;
    applyMutation((prev) => deleteRange(prev, offset, offset + 1));
  }, [applyMutation]);

  const handleClose = useCallback(() => {
    const offset = placeholderOffsetRef.current;
    const madeSelection = selectionMadeRef.current;

    if (offset !== null && !madeSelection) {
      // Place cursor right after the placeholder character.
      applyMutation((prev) => ({
        ...prev,
        selection: { type: 'collapsed', offset: offset + 1 },
      }));
    }

    popupOpenRef.current = false;
    flushSync(() => setPopup(null));
    placeholderOffsetRef.current = null;
    blockServerIdRef.current = undefined;
    selectionMadeRef.current = false;

    if (hadFocusBeforeRef.current) {
      rootRef.current?.focus();
    }
    hadFocusBeforeRef.current = false;
  }, [applyMutation, rootRef]);

  const handleDeletePlaceholder = useCallback(() => {
    removePlaceholder();
    popupOpenRef.current = false;
    flushSync(() => setPopup(null));
    placeholderOffsetRef.current = null;
    blockServerIdRef.current = undefined;
    selectionMadeRef.current = false;

    if (hadFocusBeforeRef.current) {
      rootRef.current?.focus();
    }
    hadFocusBeforeRef.current = false;
  }, [removePlaceholder, rootRef]);

  const insertPill = useCallback(
    (nodeUuid: string, refType: 'node' | 'class' | 'user') => {
      removePlaceholder();
      applyMutation((prev) =>
        insertAtomicNode(prev, nodeLink(buildLinkId(nodeUuid, generateUUID()), refType)),
      );
    },
    [applyMutation, removePlaceholder],
  );

  const insertDateRange = useCallback(
    (value: DateRangeValue) => {
      removePlaceholder();
      applyMutation((prev) =>
        insertAtomicNode(
          prev,
          buildDateRangeNode(
            value.start,
            value.end,
            value.granularity,
            value.start_uuid,
            value.end_uuid,
          ),
        ),
      );
    },
    [applyMutation, removePlaceholder],
  );

  const insertEmbedSibling = useCallback(
    async (nodeUuid: string) => {
      const offset = placeholderOffsetRef.current;
      if (offset === null) return;

      const runtime = getOperationRuntime();
      const hostNode = getNode(runtime, blockId);
      if (!hostNode?.parentId) return;

      removePlaceholder();
      const newBlockId = generateUUID();
      useEditorFocusStore.getState().setPendingFocus(newBlockId);
      await applyRuntimeIntent({
        type: 'create_block',
        parentId: hostNode.parentId,
        afterBlockId: blockId,
        blockId: newBlockId,
        contentAST: [
          {
            type: 'paragraph',
            children: [{ type: 'node_link', link_id: nodeUuid, ref_type: 'embed' }],
          },
        ],
      });
      getRuntimeEventBus().flushEvents();
    },
    [blockId, removePlaceholder],
  );

  const handleSelectNode = useCallback(
    (node: Node, mode: 'default' | 'alternative', isUserMention = false) => {
      if (!popup) return;

      selectionMadeRef.current = true;
      removePlaceholder();

      if (popup.context === 'template') {
        onTemplateInstantiate?.(node.uuid, blockServerIdRef.current);
        handleClose();
        return;
      }

      if (popup.context === 'embed') {
        void insertEmbedSibling(node.uuid);
        handleClose();
        return;
      }

      switch (popup.type) {
        case 'class': {
          if (mode === 'alternative') {
            insertPill(node.uuid, 'class');
            flushAllContentSaves();
          }
          if (blockServerIdRef.current != null) {
            onAddClass?.(blockServerIdRef.current, node.uuid);
          }
          break;
        }
        case 'link': {
          insertPill(node.uuid, isUserMention ? 'user' : 'node');
          break;
        }
        case 'tag': {
          insertPill(node.uuid, 'node');
          break;
        }
      }

      handleClose();
    },
    [popup, removePlaceholder, insertPill, insertEmbedSibling, onAddClass, onTemplateInstantiate, handleClose],
  );

  const handleSelectCommand = useCallback(
    (commandId: string) => {
      removePlaceholder();

      if (commandId === 'template') {
        const coords = getCaretCoordinates(rootRef.current ?? document.body);
        setPopup({
          type: 'link',
          position: coords,
          context: 'template',
          classFilters: templateClassFilters,
        });
        return;
      }

      if (commandId === 'embed') {
        const coords = getCaretCoordinates(rootRef.current ?? document.body);
        setPopup({
          type: 'link',
          position: coords,
          context: 'embed',
        });
        return;
      }

      if (commandId === 'date-range') {
        handleClose();
        setDateRangePickerOpen(true);
        return;
      }

      const pluginCommand = getSlashCommand(commandId);
      if (pluginCommand) {
        pluginCommand.execute({
          editor: { root: rootRef.current, blockId, applyMutation },
          blockServerId: blockServerIdRef.current ?? null,
        });
        handleClose();
        return;
      }

      onSlashCommand?.(commandId, blockServerIdRef.current);
      handleClose();
    },
    [
      removePlaceholder,
      rootRef,
      blockId,
      applyMutation,
      onSlashCommand,
      templateClassFilters,
      handleClose,
    ],
  );

  // Hide the /cloze command unless the active block's parent is a card node.
  const hiddenSlashCommandIds = (() => {
    const hidden = new Set<string>();
    const blockServerId = blockServerIdRef.current;
    if (blockServerId == null) {
      hidden.add('cloze');
      return hidden;
    }

    const runtime = getOperationRuntime();
    const blockNode = getAllNodes(runtime).find((n) => n.blockId === blockServerId);
    if (!blockNode?.parentId) {
      hidden.add('cloze');
      return hidden;
    }

    const parentNode = getAllNodes(runtime).find((n) => n.blockId === blockNode.parentId);
    const parentIsCard = parentNode?.classIds.includes(SYSTEM_CLASS_UUIDS.card) ?? false;
    if (!parentIsCard) {
      hidden.add('cloze');
    }
    return hidden;
  })();

  // Trigger detection helpers.
  const tryOpenTrigger = useCallback(
    (key: string, fromComposition = false) => {
      if (popupOpenRef.current) return;
      if (!isTriggerChar(key)) return;

      const state = stateRef.current;
      const sel = state.selection;
      let offset: number;
      if (sel.type === 'collapsed') {
        offset = sel.offset;
      } else if (sel.type === 'range') {
        // Don't trigger in the middle of a selection.
        return;
      } else {
        // 'node' selection — treat as boundary at the node index.
        offset = sel.nodeIndex;
      }

      const prevChar = fromComposition ? getCharBeforeOffset(state, offset - 1) : getCharBeforeOffset(state, offset);
      if (!isValidTrigger(key, prevChar)) return;

      openTrigger(key, fromComposition);
    },
    [stateRef, openTrigger],
  );

  // Keyboard trigger detection.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (popupOpenRef.current) return;

      const isAltGraph = event.getModifierState('AltGraph');
      if (event.metaKey) return;
      if (event.ctrlKey && !isAltGraph) return;

      const key = event.key;
      if (!isTriggerChar(key)) return;

      event.preventDefault();
      event.stopPropagation();
      tryOpenTrigger(key, false);
    };

    root.addEventListener('keydown', handleKeyDown, true);
    return () => root.removeEventListener('keydown', handleKeyDown, true);
  }, [rootRef, tryOpenTrigger]);

  // beforeinput trigger detection (covers mobile soft keyboards and most browsers).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const handleBeforeInput = (event: InputEvent) => {
      if (popupOpenRef.current) return;
      if (!['insertText', 'insertFromComposition', 'insertCompositionText'].includes(event.inputType ?? '')) return;
      const data = event.data;
      if (!data || data.length !== 1 || !isTriggerChar(data)) return;

      event.preventDefault();
      event.stopPropagation();
      tryOpenTrigger(data, false);
    };

    root.addEventListener('beforeinput', handleBeforeInput, true);
    return () => root.removeEventListener('beforeinput', handleBeforeInput, true);
  }, [rootRef, tryOpenTrigger]);

  // Composition end fallback for IMEs that don't fire regular beforeinput keys.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const handleCompositionEnd = (event: CompositionEvent) => {
      if (popupOpenRef.current) return;
      const data = event.data;
      if (!data || data.length !== 1 || !isTriggerChar(data)) return;

      // Let the editor's composition handler insert the character first, then
      // check whether it forms a valid trigger.
      queueMicrotask(() => {
        if (popupOpenRef.current) return;
        const state = stateRef.current;
        const sel = state.selection;
        if (sel.type !== 'collapsed') return;
        const offset = sel.offset;
        const prevChar = getCharBeforeOffset(state, offset - 1);
        if (!isValidTrigger(data, prevChar)) return;
        openTrigger(data, true);
      });
    };

    root.addEventListener('compositionend', handleCompositionEnd);
    return () => root.removeEventListener('compositionend', handleCompositionEnd);
  }, [rootRef, stateRef, openTrigger]);

  if (!popup) return null;

  return (
    <>
      <TriggerPopup
        type={popup.type}
        position={popup.position}
        onSelectNode={popup.type !== 'slash' ? handleSelectNode : undefined}
        onSelectCommand={popup.type === 'slash' ? handleSelectCommand : undefined}
        onClose={handleClose}
        onDeletePlaceholder={handleDeletePlaceholder}
        hiddenSlashCommandIds={hiddenSlashCommandIds}
        contextBlockServerId={blockServerIdRef.current}
      />
      {dateRangePickerOpen && (
        <DateRangePicker
          onChange={(value) => {
            if (value) insertDateRange(value);
            setDateRangePickerOpen(false);
          }}
          onClose={() => setDateRangePickerOpen(false)}
        />
      )}
    </>
  );
}
