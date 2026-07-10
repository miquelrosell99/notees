/**
 * CustomInlineEditor — Lightweight contentEditable inline editor that replaces
 * Lexical for block content editing.
 *
 * - Uses ContentAST as the source of truth.
 * - Renders via InlineContentRenderer.
 * - Handles keyboard, composition, and pointer input directly.
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  forwardRef,
  memo,
  type JSX,
} from 'react';
import type { ContentAST } from '@/runtime/types';
import type { ASTInlineNode } from '@/types/ast';
import { serializeContentAST } from '@/features/editor/editor/editorConfig';
import {
  createState,
  insertText,
  deleteBackward,
  deleteForward,
  insertHardBreak,
  toggleMark,
  moveCursor,
  extendSelection,
  deleteRange,
  astToUnits,
  getInlineChildren,
  getLogicalLength,
  removeLinkById,
  replaceLinkById,
  toggleLinkClassById,
  unitsFromState,
} from '../model/inlineEditorModel';
import { LinkEditModal, type LinkEditResult } from '@/features/editor/editor/components/LinkEditModal';
import { generateUUID } from '@/utils/uuid';
import { buildLinkId } from '@/lib/astBuilder';
import type { InlineEditorState } from '../model/types';
import { getDOMSelectionRange, setDOMSelection } from '../model/selectionSync';
import { InlineContentRenderer } from './InlineContentRenderer';
import type { InlineEditorHandle, InlineLinkRefType } from '@/features/editor/editor/types';
import { useInlineEditorRegistry } from '@/stores/inlineEditorRegistry';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { InlineTriggers } from '../plugins/InlineTriggers';
import { InlineNodeLinks } from '../plugins/InlineNodeLinks';
import { InlineCopyPaste } from '../plugins/InlineCopyPaste';
import { useInlineCopyPaste } from '../plugins/useInlineCopyPaste';
import { FloatingToolbar } from '../plugins/FloatingToolbar';
import { isInsideEditorCompanion } from '../utils/editorCompanion';
import '@/styles/inline-link.css';
import './CustomInlineEditor.css';

interface CustomInlineEditorProps {
  blockId: string;
  initialContentAST: ContentAST;
  readOnly?: boolean;
  placeholder?: string;
  initialCursorOffset?: number;
  onContentChange?: (blockId: string, content: string) => void;
  onPillClick?: (linkId: string, refType: InlineLinkRefType) => void;
  onPillRemove?: (linkId: string) => void;
  onAddClass?: (blockServerId: string, classId: string) => void;
  onSlashCommand?: (commandId: string, blockServerId: string | undefined) => void;
  onPasteImage?: (blockServerId: string, file: File, hasContent: boolean) => void;
  onTemplateInstantiate?: (templateNodeId: string, blockServerId: string | undefined) => void;
  templateClassFilters?: string[];
  nodeUuid?: string;
  blockUuid?: string;
  onEnter?: () => void;
  onCtrlEnter?: () => void;
  onBackspaceAtStart?: () => void;
  onDeleteAtEnd?: () => void;
  onEscape?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  isPage?: boolean;
  hasNodeColor?: boolean;
  inCard?: boolean;
  cardTitle?: boolean;
  listSize?: 'sm' | 'md';
  inPropertyEditor?: boolean;
}

const MOVE_STEP = 1;
const WORD_STEP = 4;

function getLinkId(node: ASTInlineNode): string | null {
  if (node.type === 'node_link' || node.type === 'broken_link') return node.link_id;
  if (node.type === 'external_link') return node.url;
  return null;
}

function findRemovedLinkIds(prev: InlineEditorState, next: InlineEditorState): string[] {
  const prevUnits = astToUnits(getInlineChildren(prev.ast));
  const nextUnits = astToUnits(getInlineChildren(next.ast));
  const nextLinkIds = new Set<string>();
  for (const unit of nextUnits) {
    if (unit.type === 'atomic') {
      const id = getLinkId(unit.node);
      if (id) nextLinkIds.add(id);
    }
  }
  const removed: string[] = [];
  for (const unit of prevUnits) {
    if (unit.type === 'atomic') {
      const id = getLinkId(unit.node);
      if (id && !nextLinkIds.has(id)) removed.push(id);
    }
  }
  return removed;
}

export const CustomInlineEditor = memo(
  forwardRef<InlineEditorHandle, CustomInlineEditorProps>(function CustomInlineEditor(
    {
      blockId,
      initialContentAST,
      readOnly = false,
      placeholder = '',
      initialCursorOffset,
      onContentChange,
      onPillClick: _onPillClick,
      onPillRemove: _onPillRemove,
      onAddClass: _onAddClass,
      onSlashCommand: _onSlashCommand,
      onPasteImage: _onPasteImage,
      onTemplateInstantiate: _onTemplateInstantiate,
      templateClassFilters: _templateClassFilters,
      nodeUuid: _nodeUuid,
      blockUuid: _blockUuid,
      onEnter,
      onCtrlEnter,
      onBackspaceAtStart,
      onDeleteAtEnd,
      onEscape,
      onFocus,
      onBlur,
      isPage,
      hasNodeColor,
      inCard,
      cardTitle,
      listSize,
      inPropertyEditor,
    },
    ref,
  ): JSX.Element {
    const rootRef = useRef<HTMLDivElement>(null);
    const [state, setState] = useState<InlineEditorState>(() => {
      const initial = createState(initialContentAST);
      const baseOffset = initial.selection.type === 'collapsed'
        ? initial.selection.offset
        : initial.selection.type === 'range'
          ? Math.min(initial.selection.anchor, initial.selection.focus)
          : initial.selection.nodeIndex;
      const offset = initialCursorOffset ?? baseOffset;
      return { ...initial, selection: { type: 'collapsed', offset } };
    });

    const stateRef = useRef(state);
    stateRef.current = state;

    const isComposingRef = useRef(false);
    const hasFocusRef = useRef(false);
    const applySelectionRef = useRef<number | { anchor: number; focus: number } | null>(null);
    const editorHandleRef = useRef<InlineEditorHandle | null>(null);
    const onPillRemoveRef = useRef(_onPillRemove);
    onPillRemoveRef.current = _onPillRemove;

    const [selectedPillLinkId, setSelectedPillLinkId] = useState<string | null>(null);
    const [editingLinkId, setEditingLinkId] = useState<string | null>(null);

    // Notify parent of content changes.
    useEffect(() => {
      onContentChange?.(blockId, serializeContentAST(state.ast));
    }, [blockId, onContentChange, state.ast]);

    // Typing or any AST mutation should clear the visual pill selection.
    useEffect(() => {
      setSelectedPillLinkId(null);
    }, [state.ast]);

    // Apply pending DOM selection after render.
    useLayoutEffect(() => {
      if (!rootRef.current) return;
      const selectionTarget = applySelectionRef.current;
      applySelectionRef.current = null;

      let target: number | { anchor: number; focus: number };
      if (selectionTarget === null) {
        if (state.selection.type === 'collapsed') {
          target = state.selection.offset;
        } else if (state.selection.type === 'range') {
          target = { anchor: state.selection.anchor, focus: state.selection.focus };
        } else {
          target = state.selection.nodeIndex;
        }
      } else {
        target = selectionTarget;
      }

      if (hasFocusRef.current) {
        if (typeof target === 'number') {
          setDOMSelection(rootRef.current, target);
        } else {
          setDOMSelection(rootRef.current, target.anchor, target.focus);
        }
      }
    }, [state]);

    const applyMutation = useCallback(
      (mutator: (prev: InlineEditorState) => InlineEditorState) => {
        setState((prev) => {
          const next = mutator(prev);
          stateRef.current = next;

          const removedLinkIds = findRemovedLinkIds(prev, next);
          for (const linkId of removedLinkIds) {
            onPillRemoveRef.current?.(linkId);
          }

          if (next.selection.type === 'collapsed') {
            applySelectionRef.current = next.selection.offset;
          } else if (next.selection.type === 'range') {
            applySelectionRef.current = { anchor: next.selection.anchor, focus: next.selection.focus };
          }
          return next;
        });
      },
      [],
    );

    const handleEditPill = useCallback((linkId: string) => {
      setEditingLinkId(linkId);
    }, []);

    const handleRemovePill = useCallback((linkId: string) => {
      applyMutation((prev) => removeLinkById(prev, linkId));
    }, [applyMutation]);

    const handleToggleClassPill = useCallback((linkId: string) => {
      applyMutation((prev) => toggleLinkClassById(prev, linkId));
    }, [applyMutation]);

    const handleCloseEditModal = useCallback(() => {
      setEditingLinkId(null);
    }, []);

    const handleSaveEditModal = useCallback(
      (result: LinkEditResult) => {
        if (!editingLinkId) return;
        applyMutation((prev) => {
          const units = astToUnits(getInlineChildren(prev.ast));
          const unit = units.find(
            (u) => u.type === 'atomic' && getLinkId(u.node) === editingLinkId,
          );
          if (!unit || unit.type !== 'atomic') return prev;

          let newNode: ASTInlineNode | null = null;

          if (result.mode === 'url') {
            newNode = {
              type: 'external_link',
              url: result.url ?? '',
              children: result.label
                ? [{ type: 'text', text: result.label }]
                : [],
            };
          } else if (result.targetNode) {
            const newLinkId = buildLinkId(result.targetNode.uuid, generateUUID());
            newNode = {
              type: 'node_link',
              link_id: newLinkId,
              ref_type: 'node',
              label: result.label ?? undefined,
            };
          } else {
            // Label-only change: mutate the existing link node in place.
            const current = unit.node;
            if (current.type === 'node_link' || current.type === 'broken_link') {
              newNode = { ...current, label: result.label ?? undefined };
            } else if (current.type === 'external_link') {
              newNode = {
                ...current,
                children: result.label
                  ? [{ type: 'text', text: result.label }]
                  : [],
              };
            }
          }

          if (!newNode) return prev;
          return replaceLinkById(prev, editingLinkId, newNode);
        });
        setEditingLinkId(null);
      },
      [applyMutation, editingLinkId],
    );

    const editingLinkNode = useMemo(() => {
      if (!editingLinkId) return null;
      const units = astToUnits(getInlineChildren(state.ast));
      const unit = units.find(
        (u) => u.type === 'atomic' && getLinkId(u.node) === editingLinkId,
      );
      return unit?.type === 'atomic' ? unit.node : null;
    }, [editingLinkId, state.ast]);

    // Hold the editor's active block alive while the pill "Edit link" modal is
    // open. The modal is portaled and focuses its input, which blurs the editor;
    // without popupOpen, blurBlock() clears activeBlockId and unmounts this
    // component (and the modal with it), so handleSaveEditModal's applyMutation
    // would land on a dead instance. Same invariant as InlineTriggers' pickers.
    useEffect(() => {
      if (!editingLinkId) return;
      useEditorFocusStore.getState().openPopup();
      return () => {
        useEditorFocusStore.getState().closePopup();
      };
    }, [editingLinkId]);

    const handleBeforeInput = useCallback(
      (event: InputEvent) => {
        if (readOnly) return;
        event.preventDefault();

        if (isComposingRef.current) return;

        switch (event.inputType) {
          case 'insertText':
          case 'insertCompositionText':
          case 'insertFromComposition': {
            const data = event.data ?? '';
            if (data) applyMutation((prev) => insertText(prev, data));
            break;
          }
          case 'insertLineBreak':
          case 'insertParagraph':
            applyMutation(insertHardBreak);
            break;
          case 'deleteContentBackward':
            applyMutation(deleteBackward);
            break;
          case 'deleteContentForward':
            applyMutation(deleteForward);
            break;
          default:
            // Allow other input types (paste, drop) to be handled elsewhere.
            break;
        }
      },
      [applyMutation, readOnly],
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (readOnly) return;
        // Ignore keystrokes that originate outside the editable root (e.g. inputs
        // in portaled popups such as the link insertion popup).
        if (!rootRef.current?.contains(e.target as Node)) return;
        if (isInsideEditorCompanion(e.target)) return;

        const { key, shiftKey, ctrlKey, metaKey, altKey } = e;
        const mod = ctrlKey || metaKey;

        // Mark formatting shortcuts.
        if (mod && !shiftKey && !altKey) {
          switch (key.toLowerCase()) {
            case 'b':
              e.preventDefault();
              applyMutation((prev) => toggleMark(prev, 'strong'));
              return;
            case 'i':
              e.preventDefault();
              applyMutation((prev) => toggleMark(prev, 'em'));
              return;
            case 'u':
              e.preventDefault();
              applyMutation((prev) => toggleMark(prev, 'underline'));
              return;
          }
        }

        if (mod && shiftKey && !altKey && key.toLowerCase() === 'x') {
          e.preventDefault();
          applyMutation((prev) => toggleMark(prev, 'strikethrough'));
          return;
        }

        if (key === 'Enter') {
          e.preventDefault();
          if (mod || ctrlKey) {
            onCtrlEnter?.();
          } else if (shiftKey) {
            applyMutation(insertHardBreak);
          } else {
            onEnter?.();
          }
          return;
        }

        if (key === 'Backspace') {
          e.preventDefault();
          if (stateRef.current.selection.type === 'collapsed' && stateRef.current.selection.offset === 0) {
            onBackspaceAtStart?.();
          } else {
            applyMutation(deleteBackward);
          }
          return;
        }

        if (key === 'Delete') {
          e.preventDefault();
          const length = getLogicalLength(unitsFromState(stateRef.current));
          if (
            stateRef.current.selection.type === 'collapsed' &&
            stateRef.current.selection.offset >= length
          ) {
            onDeleteAtEnd?.();
          } else {
            applyMutation(deleteForward);
          }
          return;
        }

        if (key === 'Escape') {
          e.preventDefault();
          onEscape?.();
          return;
        }

        const step = mod ? WORD_STEP : MOVE_STEP;

        if (key === 'ArrowLeft') {
          e.preventDefault();
          if (shiftKey) {
            applyMutation((prev) => extendSelection(prev, -step));
          } else {
            applyMutation((prev) => moveCursor(prev, -step));
          }
          return;
        }

        if (key === 'ArrowRight') {
          e.preventDefault();
          if (shiftKey) {
            applyMutation((prev) => extendSelection(prev, step));
          } else {
            applyMutation((prev) => moveCursor(prev, step));
          }
          return;
        }
      },
      [applyMutation, onEnter, onCtrlEnter, onBackspaceAtStart, onDeleteAtEnd, onEscape, readOnly],
    );

    // Attach a native beforeinput listener directly. React's synthetic
    // onBeforeInput is not reliably delivered on contentEditable elements in
    // all browsers, which caused keystrokes to be ignored.
    useEffect(() => {
      const root = rootRef.current;
      if (!root || readOnly) return;

      const handler = (event: Event) => {
        // Trigger chars are handled by InlineTriggers, which stops propagation.
        if (event.defaultPrevented) return;
        if (isInsideEditorCompanion(event.target)) return;
        handleBeforeInput(event as InputEvent);
      };

      root.addEventListener('beforeinput', handler);
      return () => root.removeEventListener('beforeinput', handler);
    }, [handleBeforeInput, readOnly]);

    // Sync user-driven DOM selection changes (mouse, touch, Ctrl+A, etc.) back
    // into editor state so range operations (delete, type-to-replace) act on the
    // real selection instead of the stale collapsed cursor.
    useEffect(() => {
      if (readOnly) return;
      const root = rootRef.current;
      if (!root) return;

      const handleSelectionChange = () => {
        const domSel = getDOMSelectionRange(root);
        if (!domSel) return;

        // Ignore the selectionchange events fired by our own setDOMSelection calls.
        const pending = applySelectionRef.current;
        if (pending !== null) {
          if (typeof pending === 'number' && domSel.isCollapsed && domSel.anchor === pending) {
            return;
          }
          if (
            typeof pending === 'object' &&
            !domSel.isCollapsed &&
            domSel.anchor === pending.anchor &&
            domSel.focus === pending.focus
          ) {
            return;
          }
        }

        const sel = stateRef.current.selection;
        const unchanged =
          (sel.type === 'collapsed' && domSel.isCollapsed && sel.offset === domSel.anchor) ||
          (sel.type === 'range' &&
            !domSel.isCollapsed &&
            sel.anchor === domSel.anchor &&
            sel.focus === domSel.focus);
        if (unchanged) return;

        if (domSel.isCollapsed) {
          setState((prev) => ({ ...prev, selection: { type: 'collapsed', offset: domSel.anchor } }));
        } else {
          setState((prev) => ({
            ...prev,
            selection: { type: 'range', anchor: domSel.anchor, focus: domSel.focus },
          }));
        }
      };

      document.addEventListener('selectionchange', handleSelectionChange);
      return () => document.removeEventListener('selectionchange', handleSelectionChange);
    }, [readOnly]);

    const handleCompositionStart = useCallback(() => {
      isComposingRef.current = true;
    }, []);

    const handleCompositionEnd = useCallback(
      (e: React.CompositionEvent<HTMLDivElement>) => {
        isComposingRef.current = false;
        const data = e.data;
        if (data) {
          applyMutation((prev) => insertText(prev, data));
        }
      },
      [applyMutation],
    );

    const handleFocus = useCallback(() => {
      hasFocusRef.current = true;
      useEditorFocusStore.getState().focusBlock(blockId);
      onFocus?.();
    }, [blockId, onFocus]);

    const handleBlur = useCallback(() => {
      hasFocusRef.current = false;
      setSelectedPillLinkId(null);
      useEditorFocusStore.getState().blurBlock(blockId);
      onBlur?.();
    }, [blockId, onBlur]);

    const handlePaste = useInlineCopyPaste({
      stateRef,
      applyMutation,
      blockId,
      onPasteImage: _onPasteImage,
    });

    // Imperative API for BlockList keyboard navigation and find/replace.
    useImperativeHandle(
      ref,
      () => {
        const handle: InlineEditorHandle = {
          focus: () => {
            rootRef.current?.focus();
          },
          blur: () => {
            rootRef.current?.blur();
          },
          getCursorPosition: () => {
            const sel = stateRef.current.selection;
            if (sel.type === 'node') return 'middle';
            const offset = sel.type === 'collapsed' ? sel.offset : Math.min(sel.anchor, sel.focus);
            if (offset === 0) return 'start';
            const length = stateRef.current.ast[0]?.type === 'paragraph' || stateRef.current.ast[0]?.type === 'heading'
              ? (stateRef.current.ast[0].children ?? []).reduce((sum, n) => sum + ('text' in n ? (n.text as string).length : 1), 0)
              : 0;
            if (offset >= length) return 'end';
            return 'middle';
          },
          getCursorOffset: () => {
            const sel = stateRef.current.selection;
            if (sel.type === 'node') return sel.nodeIndex;
            return sel.type === 'collapsed' ? sel.offset : Math.min(sel.anchor, sel.focus);
          },
          getText: () => {
            return astToUnits(getInlineChildren(stateRef.current.ast))
              .map((unit) => (unit.type === 'text' ? unit.text : ''))
              .join('');
          },
          replaceRange: (start, end, text) => {
            applyMutation((prev) => {
              const cleared = deleteRange(prev, start, end);
              return insertText(cleared, text);
            });
          },
          selectRange: (start, end) => {
            setState((prev) => {
              const next = { ...prev, selection: { type: 'range' as const, anchor: start, focus: end } };
              applySelectionRef.current = { anchor: start, focus: end };
              return next;
            });
          },
          scrollIntoView: () => {
            rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          },
        };
        editorHandleRef.current = handle;
        return handle;
      },
      [applyMutation],
    );

    // Register this editor instance for page-level features (find/replace).
    useEffect(() => {
      const handle = editorHandleRef.current;
      if (!handle) return;
      useInlineEditorRegistry.getState().register(blockId, handle);
      return () => {
        useInlineEditorRegistry.getState().unregister(blockId);
      };
    }, [blockId]);

    const serializedAST = useMemo(() => serializeContentAST(state.ast), [state.ast]);
    const isEmpty = state.ast[0]?.type === 'paragraph' && (state.ast[0].children ?? []).length === 1 &&
      state.ast[0].children![0].type === 'text' && state.ast[0].children![0].text === '';

    const editingLinkRefType: InlineLinkRefType = useMemo(() => {
      if (!editingLinkNode) return 'node';
      if (editingLinkNode.type === 'external_link') return 'url';
      if (editingLinkNode.type === 'broken_link') return 'broken';
      if (editingLinkNode.type === 'node_link') return editingLinkNode.ref_type;
      return 'node';
    }, [editingLinkNode]);

    const editingLinkUrl = editingLinkNode?.type === 'external_link' ? editingLinkNode.url : undefined;

    const editingLinkLabel = useMemo(() => {
      if (!editingLinkNode) return null;
      if (editingLinkNode.type === 'external_link') {
        return editingLinkNode.children
          .map((child) => ('text' in child ? (child as { text: string }).text : ''))
          .join('') || null;
      }
      if (editingLinkNode.type === 'node_link' || editingLinkNode.type === 'broken_link') {
        return editingLinkNode.label ?? null;
      }
      return null;
    }, [editingLinkNode]);

    return (
      <>
        <div
          ref={rootRef}
          className="custom-inline-editor"
          contentEditable={!readOnly}
          suppressContentEditableWarning
          data-block-id={blockId}
          data-page={isPage || undefined}
          data-has-node-color={hasNodeColor || undefined}
          data-in-card={inCard || undefined}
          data-card-title={cardTitle || undefined}
          data-list-size={listSize || undefined}
          data-property-editor={inPropertyEditor || undefined}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onPaste={!readOnly ? handlePaste : undefined}
          role="textbox"
          tabIndex={0}
          aria-label="Block content"
          aria-multiline="false"
        >
          <InlineContentRenderer
            name={serializedAST}
            editable={!readOnly}
            onPillClick={_onPillClick}
            onEditPill={handleEditPill}
            onRemovePill={handleRemovePill}
            onToggleClassPill={handleToggleClassPill}
            selectedPillLinkId={selectedPillLinkId}
          />
          {isEmpty && placeholder && (
            <span className="custom-inline-editor__placeholder" aria-hidden="true">
              {placeholder}
            </span>
          )}
          {!readOnly && (
            <>
              <InlineTriggers
                rootRef={rootRef}
                stateRef={stateRef}
                applyMutation={applyMutation}
                blockId={blockId}
                onAddClass={_onAddClass}
                onSlashCommand={_onSlashCommand}
                onTemplateInstantiate={_onTemplateInstantiate}
                templateClassFilters={_templateClassFilters}
              />
              <InlineNodeLinks
                rootRef={rootRef}
                stateRef={stateRef}
                applyMutation={applyMutation}
                selectedPillLinkId={selectedPillLinkId}
                setSelectedPillLinkId={setSelectedPillLinkId}
                onPillClick={_onPillClick}
              />
              <InlineCopyPaste rootRef={rootRef} blockId={blockId} />
              <FloatingToolbar rootRef={rootRef} stateRef={stateRef} applyMutation={applyMutation} />
            </>
          )}
        </div>
        {editingLinkId && editingLinkNode && (
          <LinkEditModal
            isOpen={true}
            linkId={editingLinkId}
            refType={editingLinkRefType}
            currentUrl={editingLinkUrl}
            currentLabel={editingLinkLabel}
            onSave={handleSaveEditModal}
            onClose={handleCloseEditModal}
          />
        )}
      </>
    );
  }),
);
