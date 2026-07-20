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
import { createPortal, flushSync } from 'react-dom';
import type { Node } from '@/types';
import type { Property, PropertyCreate } from '@/types/api';
import { TriggerPopup, type TriggerPopupType } from '@/features/editor/editor/plugins/TriggerPopup';
import { LinkEditModal, type LinkEditResult } from '@/features/editor';
import { DateRangePicker } from '@/features/properties/components/DateRangePicker';
import {
  PropertySuggestionPopup,
  useSetNodeProperty,
  useCreateProperty,
} from '@/features/properties';
import { DatePickerPopup, useCreateComment } from '@/features/content';
import { getOrCreateDailyNote } from '@/features/content/hooks/useNodeDateQueries';
import { generateUUID } from '@/utils/uuid';
import type { DateRangeValue } from '@/utils/dateRange';
import { useParams } from 'react-router-dom';
import { getWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { serializeContentAST } from '@/features/editor/editor/editorConfig';
import { useViewportFlip } from '@/hooks/useViewportFlip';
import { getSlashCommand } from '@/plugins/core';
import { Modal, Button, TextField } from '@/components/ui';
import { buildLinkId, nodeLink, dateRange as buildDateRangeNode, externalLink, text as textNode } from '@/lib/astBuilder';
import {
  insertText,
  deleteRange,
  insertAtomicNode,
  astToUnits,
  getInlineChildren,
  offsetToPosition,
} from '../model/inlineEditorModel';
import { isInsideEditorCompanion } from '../utils/editorCompanion';
import type { InlineEditorState } from '../model/types';
import type { ASTDocument } from '@/types/ast';

interface PopupState {
  type: TriggerPopupType;
  position: { top: number; left: number; caretTop: number };
  context?: 'template' | 'embed';
  classFilters?: string[];
  /** When type === 'link', optionally constrain results (e.g. blocks only for /blocklink) */
  linkSearchMode?: 'all' | 'pages' | 'blocks';
  /** Inline (block-as-search-field) mode — used for the slash (`/`) popup */
  inline?: boolean;
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

/**
 * Extract plain text between two logical offsets (text nodes only; atomic nodes are
 * skipped). Used to read the inline slash-command query from the block.
 */
function getTextInRange(state: InlineEditorState, start: number, end: number): string {
  if (end <= start) return '';
  const units = astToUnits(getInlineChildren(state.ast));
  let out = '';
  let pos = 0;
  for (const unit of units) {
    const len = unit.type === 'text' ? unit.text.length : 1;
    const unitStart = pos;
    const unitEnd = pos + len;
    pos = unitEnd;
    if (unitEnd <= start) continue;
    if (unitStart >= end) break;
    if (unit.type === 'text') {
      const from = Math.max(0, start - unitStart);
      const to = Math.min(len, end - unitStart);
      out += unit.text.slice(from, to);
    }
  }
  return out;
}

/**
 * Caret position in VIEWPORT coordinates (getBoundingClientRect space).
 * TriggerPopup and the follow-on pickers are position: fixed, so scroll
 * offsets must NOT be added — doing so strands the popup off-screen whenever
 * the page is scrolled.
 */
function getCaretCoordinates(root: HTMLElement): { top: number; left: number; caretTop: number } {
  const rootRect = root.getBoundingClientRect();
  const fallback = {
    top: rootRect.bottom,
    left: rootRect.left,
    caretTop: rootRect.top,
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
    top: rect.bottom,
    left: rect.left,
    caretTop: rect.top,
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
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [dateRangePickerOpen, setDateRangePickerOpen] = useState(false);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [dateAnchorPos, setDateAnchorPos] = useState<{ top: number; left: number } | null>(null);
  const [urlModalOpen, setUrlModalOpen] = useState(false);
  const [propertyPickerOpen, setPropertyPickerOpen] = useState(false);
  const [propertyAnchorPos, setPropertyAnchorPos] = useState<{ top: number; left: number } | null>(null);
  const [commentPromptOpen, setCommentPromptOpen] = useState(false);
  const [commentText, setCommentText] = useState('');
  const dateAnchorRef = useRef<HTMLSpanElement>(null);
  const propertyAnchorRef = useRef<HTMLSpanElement>(null);
  const propertyPopupRef = useRef<HTMLDivElement>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);
  const dateInsertOffsetRef = useRef<number | null>(null);
  const urlInsertOffsetRef = useRef<number | null>(null);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const popupOpenRef = useRef(false);
  const placeholderOffsetRef = useRef<number | null>(null);
  const blockServerIdRef = useRef<string | undefined>(undefined);
  const hadFocusBeforeRef = useRef(false);
  const selectionMadeRef = useRef(false);
  // Inline slash popup mirrors (kept in refs so the document-level keydown handler
  // never reads stale values).
  const slashCaretRef = useRef<number>(0);
  const slashLastQueryRef = useRef('');
  const slashCountRef = useRef(0);
  const slashActiveIdRef = useRef<string | null>(null);
  // Caret rect (viewport coords — the popups are position: fixed) captured when
  // the inline slash popup opens.
  // This is the same anchor that keeps the slash popup itself correctly placed,
  // so follow-on popups (date/property) reuse it instead of re-reading the live
  // DOM selection — which is unreliable after the trigger text is deleted and can
  // return an off-screen fallback rect.
  const slashAnchorRef = useRef<{ top: number; left: number; caretTop: number } | null>(null);

  const setPropertyMutation = useSetNodeProperty();
  const createPropertyMutation = useCreateProperty();
  const createCommentMutation = useCreateComment();

  // Anchored position for the slash-command property picker (viewport-clamped).
  const propertyPosition = useViewportFlip(
    propertyAnchorRef,
    propertyPickerOpen,
    { popupHeight: 360, fixed: true, popupRef: propertyPopupRef },
  );

  useEffect(() => {
    popupOpenRef.current = popup !== null;
  }, [popup]);

  // Keep the editor's active block alive while ANY inline picker is open — the
  // trigger popup AND the follow-on pickers (date / date-range / url / property /
  // comment). blurBlock() is suppressed while popupOpen is true; without this,
  // clicking into a follow-on picker blurs the editor, clears activeBlockId, and
  // unmounts CustomInlineEditor (and InlineTriggers with it). The picker's async
  // onSelect then resolves into a dead applyMutation and the insert is silently
  // lost — which is exactly the "/date closes but inserts nothing" symptom.
  // The pickers are mutually exclusive by construction (the trigger closes before
  // a follow-on opens), so a single boolean is sufficient and there is no
  // popupOpen gap during the handoff (anyPickerOpen stays true across it).
  const anyPickerOpen =
    popup !== null ||
    datePickerOpen ||
    dateRangePickerOpen ||
    urlModalOpen ||
    propertyPickerOpen ||
    commentPromptOpen;
  useEffect(() => {
    if (anyPickerOpen) {
      useEditorFocusStore.getState().openPopup();
      return () => {
        useEditorFocusStore.getState().closePopup();
      };
    }
  }, [anyPickerOpen]);

  // Focus the comment field when the prompt opens (mirrors DatePickerPopup).
  useEffect(() => {
    if (!commentPromptOpen) return;
    const t = setTimeout(() => commentInputRef.current?.focus({ preventScroll: true }), 50);
    return () => clearTimeout(t);
  }, [commentPromptOpen]);

  const resolveBlockServerId = useCallback(() => {
    if (!workspaceId) return;
    const store = getWorkspaceStore(workspaceId);
    blockServerIdRef.current = store?.getNode(blockId)?.id;
  }, [blockId, workspaceId]);

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

      const isSlash = key === '/';
      popupOpenRef.current = true;
      if (isSlash) {
        // Inline mode: the block is the search field. Reset the query mirror and
        // capture the opening caret rect as the reliable anchor for follow-on popups.
        setSlashSelectedIndex(0);
        slashLastQueryRef.current = '';
        slashActiveIdRef.current = null;
        slashCountRef.current = 0;
        slashAnchorRef.current = coords;
      }
      setPopup({ type: triggerType(key), position: coords, ...(isSlash ? { inline: true } : {}) });
    },
    [rootRef, stateRef, applyMutation, resolveBlockServerId],
  );

  const removePlaceholder = useCallback(() => {
    const offset = placeholderOffsetRef.current;
    if (offset === null) return;
    applyMutation((prev) => deleteRange(prev, offset, offset + 1));
  }, [applyMutation]);

  /**
   * Remove the inline slash trigger text (`/` plus the typed query) in one shot.
   * Falls back to the single trigger char when no inline caret range is known.
   * Collapses the selection to the trigger offset.
   */
  const removeSlashRange = useCallback((): number | null => {
    const start = placeholderOffsetRef.current;
    if (start === null) return null;
    const end = Math.max(start + 1, slashCaretRef.current);
    applyMutation((prev) => deleteRange(prev, start, end));
    return start;
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

  // Close the inline slash popup while KEEPING the typed text in the block and
  // leaving the caret where it is (used for Esc and for deleting the '/').
  const closeInlineSlash = useCallback(() => {
    popupOpenRef.current = false;
    flushSync(() => setPopup(null));
    placeholderOffsetRef.current = null;
    blockServerIdRef.current = undefined;
    selectionMadeRef.current = false;
    slashActiveIdRef.current = null;
    slashCountRef.current = 0;
    if (hadFocusBeforeRef.current) {
      rootRef.current?.focus();
    }
    hadFocusBeforeRef.current = false;
  }, [rootRef]);

  const insertPill = useCallback(
    (nodeUuid: string, refType: 'node' | 'class' | 'user') => {
      // The trigger placeholder was already removed by handleSelectNode before
      // dispatching here. Removing it again would delete the character that now
      // sits at the trigger offset when the trigger was typed mid-text.
      applyMutation((prev) =>
        insertAtomicNode(prev, nodeLink(buildLinkId(nodeUuid, generateUUID()), refType)),
      );
    },
    [applyMutation],
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

  const handleDateSelect = useCallback(
    async (isoDate: string) => {
      const insertOffset = dateInsertOffsetRef.current;
      if (!workspaceId) return;
      const store = getWorkspaceStore(workspaceId);
      if (!store) return;
      try {
        const dayNode = getOrCreateDailyNote(store, isoDate);
        applyMutation((prev) => {
          const fallbackOffset =
            prev.selection.type === 'collapsed' ? prev.selection.offset : 0;
          const stateWithSelection = {
            ...prev,
            selection: { type: 'collapsed' as const, offset: insertOffset ?? fallbackOffset },
          };
          return insertAtomicNode(
            stateWithSelection,
            nodeLink(buildLinkId(dayNode.uuid, generateUUID())),
          );
        });
      } catch (err) {
        console.error('Failed to create daily page:', err);
        // Re-throw so the popup can surface the failure and stay open for retry
        // instead of closing silently with no link inserted.
        throw err;
      } finally {
        dateInsertOffsetRef.current = null;
      }
    },
    [applyMutation, workspaceId],
  );

  const handleUrlSave = useCallback(
    (result: LinkEditResult) => {
      const url = result.url?.trim();
      const insertOffset = urlInsertOffsetRef.current;
      setUrlModalOpen(false);
      urlInsertOffsetRef.current = null;
      if (!url) return;
      applyMutation((prev) => {
        const fallbackOffset =
          prev.selection.type === 'collapsed' ? prev.selection.offset : 0;
        const stateWithSelection = {
          ...prev,
          selection: { type: 'collapsed' as const, offset: insertOffset ?? fallbackOffset },
        };
        const label = result.label?.trim();
        return insertAtomicNode(
          stateWithSelection,
          externalLink(url, ...(label ? [textNode(label)] : [])),
        );
      });
    },
    [applyMutation],
  );

  const handlePropertySelect = useCallback(
    (property: Property) => {
      const blockServerId = blockServerIdRef.current;
      setPropertyPickerOpen(false);
      if (!blockServerId) return;
      const defaultValue = property.type === 'boolean' ? 'false' : '';
      setPropertyMutation.mutate({ nodeUuid: blockServerId, propertyId: property.uuid, value: defaultValue });
    },
    [setPropertyMutation],
  );

  const handlePropertyCreate = useCallback(
    (data: PropertyCreate & { selection_options?: { name: string; icon?: string }[] }) => {
      const blockServerId = blockServerIdRef.current;
      setPropertyPickerOpen(false);
      if (!blockServerId) return;
      const scope = data.scope ?? 'global';
      const node_uuid = scope === 'node' && !data.node_uuid ? blockServerId : data.node_uuid;
      createPropertyMutation.mutate({ ...data, scope, node_uuid } as PropertyCreate, {
        onSuccess: (newProperty) => {
          const defaultValue = newProperty.type === 'boolean' ? 'false' : '';
          setPropertyMutation.mutate({ nodeUuid: blockServerId, propertyId: newProperty.uuid, value: defaultValue });
        },
      });
    },
    [createPropertyMutation, setPropertyMutation],
  );

  const handleCommentSubmit = useCallback(() => {
    const blockServerId = blockServerIdRef.current;
    const name = commentText.trim();
    setCommentPromptOpen(false);
    if (!blockServerId || !name) return;
    createCommentMutation.mutate({ nodeUuid: blockServerId, name });
  }, [commentText, createCommentMutation]);

  const insertEmbedSibling = useCallback(
    async (nodeUuid: string) => {
      const offset = placeholderOffsetRef.current;
      if (offset === null) return;
      if (!workspaceId) return;

      const store = getWorkspaceStore(workspaceId);
      if (!store) return;

      const hostNode = store.getNode(blockId);
      if (!hostNode?.parentId) return;

      removePlaceholder();
      const newBlockId = generateUUID();
      useEditorFocusStore.getState().setPendingFocus(newBlockId);

      store.createNode({ nodeId: newBlockId, kind: 'block', parentId: hostNode.parentId });
      // TODO: ordered insertion after `blockId` requires a custom tree-CRDT update;
      // `moveNode` currently appends to the end of the parent list.
      store.moveNode(newBlockId, hostNode.parentId);
      store.updateText(newBlockId, (text) => {
        const contentAST: ASTDocument = [
          {
            type: 'paragraph',
            children: [{ type: 'node_link', link_id: nodeUuid, ref_type: 'embed' }],
          },
        ];
        const serialized = serializeContentAST(contentAST);
        const current = text.toPlaintext();
        text.delete(0, current.length);
        text.insert(0, serialized);
      });
    },
    [blockId, removePlaceholder, workspaceId],
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

  // Execute a slash command. The slash popup is inline: the trigger text
  // (`/` + typed query) is removed in one shot and the selection collapses to
  // the trigger offset, which becomes the insertion point for follow-on actions.
  const handleSelectCommand = useCallback(
    (commandId: string) => {
      const insertOffset = removeSlashRange();
      // Anchor follow-on popups to the slash popup's own position: prefer the live
      // popup state, otherwise the rect captured when the slash opened. Both are
      // the same reliable, on-screen anchor that keeps the slash popup itself
      // placed correctly. Deliberately do NOT read the live DOM selection here —
      // right after deleting the trigger text it can return an off-screen fallback
      // rect that strands the popup.
      const reopenAt = () => {
        const coords = popup?.position ?? slashAnchorRef.current;
        if (coords) return coords;
        // Ultimate fallback: anchor to the editor block root (always visible while
        // the user is editing it) rather than risk an off-screen caret read.
        const r = (rootRef.current ?? document.body).getBoundingClientRect();
        return {
          top: r.bottom,
          left: r.left,
          caretTop: r.top,
        };
      };

      // Re-openers: the '/XXXXX' text is already gone, so clear the placeholder
      // offset — otherwise the follow-up popup's single-char removal would delete
      // the character now sitting at the trigger offset.
      if (commandId === 'link' || commandId === 'blocklink' || commandId === 'type' || commandId === 'tag') {
        placeholderOffsetRef.current = null;
        const type: TriggerPopupType =
          commandId === 'type' ? 'class' : commandId === 'tag' ? 'tag' : 'link';
        setPopup({
          type,
          position: reopenAt(),
          ...(commandId === 'blocklink' ? { linkSearchMode: 'blocks' as const } : {}),
        });
        return;
      }

      if (commandId === 'template') {
        placeholderOffsetRef.current = null;
        setPopup({
          type: 'link',
          position: reopenAt(),
          context: 'template',
          classFilters: templateClassFilters,
        });
        return;
      }

      if (commandId === 'embed') {
        placeholderOffsetRef.current = null;
        setPopup({
          type: 'link',
          position: reopenAt(),
          context: 'embed',
        });
        return;
      }

      if (commandId === 'date-range') {
        handleClose();
        setDateRangePickerOpen(true);
        return;
      }

      if (commandId === 'date') {
        dateInsertOffsetRef.current = insertOffset;
        const coords = reopenAt();
        // Zero-size fixed anchor at the caret top (viewport coords) — the
        // DatePickerPopup flips/clamps from there via useViewportFlip.
        setDateAnchorPos({ top: coords.caretTop, left: coords.left });
        handleClose();
        setDatePickerOpen(true);
        return;
      }

      if (commandId === 'url') {
        urlInsertOffsetRef.current = insertOffset;
        handleClose();
        setUrlModalOpen(true);
        return;
      }

      if (commandId === 'property') {
        const coords = reopenAt();
        // Zero-size fixed anchor at the caret top (viewport coords) — the
        // property picker flips/clamps from there via useViewportFlip.
        setPropertyAnchorPos({ top: coords.caretTop, left: coords.left });
        handleClose();
        setPropertyPickerOpen(true);
        return;
      }

      if (commandId === 'comment') {
        setCommentText('');
        handleClose();
        setCommentPromptOpen(true);
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
      popup,
      removeSlashRange,
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
    if (blockServerId == null || workspaceId == null) {
      hidden.add('cloze');
      return hidden;
    }

    const store = getWorkspaceStore(workspaceId);
    if (!store) {
      hidden.add('cloze');
      return hidden;
    }

    const blockNode = store.getNode(blockServerId);
    if (!blockNode?.parentId) {
      hidden.add('cloze');
      return hidden;
    }

    const parentNode = store.getNode(blockNode.parentId);
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
      if (isInsideEditorCompanion(event.target)) return;

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
      if (isInsideEditorCompanion(event.target)) return;
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

  // ─── Inline slash popup ────────────────────────────────────────────────
  // The block itself is the search field: derive the query from the text between
  // the '/' and the caret, reset the highlight when it changes, and dismiss when
  // the '/' is removed or the caret leaves the region (text is kept).
  let inlineSlashQuery = '';
  const isInlineSlashOpen = popup?.inline === true && popup.type === 'slash';
  if (isInlineSlashOpen) {
    const st = stateRef.current;
    const triggerOffset = placeholderOffsetRef.current ?? -1;
    const caret = st.selection.type === 'collapsed' ? st.selection.offset : -1;
    slashCaretRef.current = caret;
    const slashPresent =
      triggerOffset >= 0 && getTextInRange(st, triggerOffset, triggerOffset + 1) === '/';
    const caretInRegion = caret > triggerOffset;
    if (!slashPresent || !caretInRegion) {
      // Adjust state during render (converges: next render popup is null).
      setPopup(null);
      popupOpenRef.current = false;
      placeholderOffsetRef.current = null;
      slashActiveIdRef.current = null;
      slashCountRef.current = 0;
    } else {
      inlineSlashQuery = getTextInRange(st, triggerOffset + 1, caret);
      if (slashLastQueryRef.current !== inlineSlashQuery) {
        slashLastQueryRef.current = inlineSlashQuery;
        setSlashSelectedIndex(0);
      }
    }
  }

  // Intercept ↑/↓/Enter/Esc for the inline slash popup on the editor root
  // (capture), ahead of CustomInlineEditor's React onKeyDown (bubble).
  useEffect(() => {
    if (!isInlineSlashOpen) return;
    const root = rootRef.current;
    if (!root) return;
    const handler = (event: KeyboardEvent) => {
      if (!root.contains(event.target as globalThis.Node)) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSlashSelectedIndex((i) => Math.min(i + 1, Math.max(0, slashCountRef.current - 1)));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSlashSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (event.key === 'Enter') {
        const active = slashActiveIdRef.current;
        if (active) {
          event.preventDefault();
          event.stopImmediatePropagation();
          handleSelectCommand(active);
        } else {
          // No match: close and let the editor handle Enter (newline).
          closeInlineSlash();
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeInlineSlash();
      }
    };
    root.addEventListener('keydown', handler, true);
    return () => root.removeEventListener('keydown', handler, true);
  }, [isInlineSlashOpen, rootRef, handleSelectCommand, closeInlineSlash]);

  const handleActiveCommandChange = useCallback((id: string | null, count: number) => {
    slashActiveIdRef.current = id;
    slashCountRef.current = count;
  }, []);

  const handleHighlightChange = useCallback((index: number) => {
    setSlashSelectedIndex(index);
  }, []);

  // Render nothing only when neither the trigger popup nor a follow-on picker
  // (date / date-range / url / property / comment) is active. Pickers open after
  // the trigger popup closes, so they must be allowed to render while `popup` is null.
  if (
    !popup &&
    !dateRangePickerOpen &&
    !datePickerOpen &&
    !urlModalOpen &&
    !propertyPickerOpen &&
    !commentPromptOpen
  ) {
    return null;
  }

  return (
    <>
      {popup && (
        <TriggerPopup
          type={popup.type}
          position={popup.position}
          onSelectNode={popup.type !== 'slash' ? handleSelectNode : undefined}
          onSelectCommand={popup.type === 'slash' ? handleSelectCommand : undefined}
          onClose={popup.inline ? closeInlineSlash : handleClose}
          onDeletePlaceholder={handleDeletePlaceholder}
          hiddenSlashCommandIds={hiddenSlashCommandIds}
          contextBlockServerId={blockServerIdRef.current}
          linkSearchMode={popup.linkSearchMode}
          workspaceId={workspaceId}
          inline={popup.inline}
          controlledQuery={popup.inline ? inlineSlashQuery : undefined}
          controlledSelectedIndex={popup.inline ? slashSelectedIndex : undefined}
          onActiveCommandChange={popup.inline ? handleActiveCommandChange : undefined}
          onHighlightChange={popup.inline ? handleHighlightChange : undefined}
        />
      )}
      {dateRangePickerOpen && (
        <DateRangePicker
          onChange={(value) => {
            if (value) insertDateRange(value);
            setDateRangePickerOpen(false);
          }}
          onClose={() => setDateRangePickerOpen(false)}
        />
      )}
      {datePickerOpen && dateAnchorPos && (
        <>
          {createPortal(
            <span
              ref={dateAnchorRef}
              style={{
                position: 'fixed',
                top: dateAnchorPos.top,
                left: dateAnchorPos.left,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              }}
            />,
            document.body,
          )}
          <DatePickerPopup
            onSelect={handleDateSelect}
            onClose={() => {
              setDatePickerOpen(false);
              dateInsertOffsetRef.current = null;
            }}
            anchorRef={dateAnchorRef}
          />
        </>
      )}
      {urlModalOpen && (
        <LinkEditModal
          isOpen
          linkId=""
          refType="url"
          currentUrl=""
          currentLabel={null}
          initialMode="url"
          title="Add URL"
          onSave={handleUrlSave}
          onClose={() => {
            setUrlModalOpen(false);
            urlInsertOffsetRef.current = null;
          }}
        />
      )}
      {propertyPickerOpen && propertyAnchorPos && (
        <>
          {createPortal(
            <span
              ref={propertyAnchorRef}
              style={{
                position: 'fixed',
                top: propertyAnchorPos.top,
                left: propertyAnchorPos.left,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              }}
            />,
            document.body,
          )}
          {createPortal(
            <div
              ref={propertyPopupRef}
              data-editor-companion
              style={{
                position: 'fixed',
                top: propertyPosition?.top,
                left: propertyPosition?.left,
                zIndex: 'var(--z-1000)',
                visibility: propertyPosition ? 'visible' : 'hidden',
                width: 320,
              }}
            >
              <PropertySuggestionPopup
                anchored
                isOpen
                onClose={() => setPropertyPickerOpen(false)}
                onSelect={handlePropertySelect}
                onCreate={handlePropertyCreate}
                contextNodeId={blockServerIdRef.current ?? undefined}
              />
            </div>,
            document.body,
          )}
        </>
      )}
      {commentPromptOpen && (
        <Modal
          isOpen
          onClose={() => setCommentPromptOpen(false)}
          title="Add comment"
          size="sm"
          footer={(
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-2)' }}>
              <Button variant="ghost" size="sm" onClick={() => setCommentPromptOpen(false)}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={handleCommentSubmit}>Save</Button>
            </div>
          )}
        >
          <TextField
            ref={commentInputRef}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Write a comment…"
            aria-label="Comment"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleCommentSubmit();
              }
            }}
          />
        </Modal>
      )}
    </>
  );
}
