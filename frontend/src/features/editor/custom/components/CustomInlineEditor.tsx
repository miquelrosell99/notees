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
} from '../model/inlineEditorModel';
import type { InlineEditorState } from '../model/types';
import { setDOMSelection } from '../model/selectionSync';
import { InlineContentRenderer } from './InlineContentRenderer';
import type { InlineEditorHandle } from '@/features/editor/editor/types';
import './CustomInlineEditor.css';

interface CustomInlineEditorProps {
  blockId: string;
  initialContentAST: ContentAST;
  readOnly?: boolean;
  placeholder?: string;
  initialCursorOffset?: number;
  onContentChange?: (blockId: string, content: string) => void;
  onPillClick?: (linkId: string, refType: 'node' | 'class' | 'url' | 'embed' | 'broken' | 'user') => void;
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
    const applySelectionRef = useRef<number | null>(null);

    // Notify parent of content changes.
    useEffect(() => {
      onContentChange?.(blockId, serializeContentAST(state.ast));
    }, [blockId, onContentChange, state.ast]);

    // Apply pending DOM selection after render.
    useLayoutEffect(() => {
      if (!rootRef.current) return;
      let offset = applySelectionRef.current;
      applySelectionRef.current = null;

      if (offset === null) {
        if (state.selection.type === 'collapsed') {
          offset = state.selection.offset;
        } else if (state.selection.type === 'range') {
          offset = state.selection.focus;
        } else {
          offset = state.selection.nodeIndex;
        }
      }

      if (hasFocusRef.current) {
        setDOMSelection(rootRef.current, offset);
      }
    }, [state]);

    const applyMutation = useCallback(
      (mutator: (prev: InlineEditorState) => InlineEditorState) => {
        setState((prev) => {
          const next = mutator(prev);
          if (next.selection.type === 'collapsed') {
            applySelectionRef.current = next.selection.offset;
          }
          return next;
        });
      },
      [],
    );

    const handleBeforeInput = useCallback(
      (e: React.FormEvent<HTMLDivElement> & { nativeEvent: InputEvent }) => {
        if (readOnly) return;
        const event = e.nativeEvent;
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
          const length = stateRef.current.ast[0]?.type === 'paragraph' || stateRef.current.ast[0]?.type === 'heading'
            ? (stateRef.current.ast[0].children ?? []).length
            : 0;
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
      onFocus?.();
    }, [onFocus]);

    const handleBlur = useCallback(() => {
      hasFocusRef.current = false;
      onBlur?.();
    }, [onBlur]);

    // Imperative API for BlockList keyboard navigation.
    useImperativeHandle(
      ref,
      () => ({
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
      }),
      [],
    );

    const serializedAST = useMemo(() => serializeContentAST(state.ast), [state.ast]);
    const isEmpty = state.ast[0]?.type === 'paragraph' && (state.ast[0].children ?? []).length === 1 &&
      state.ast[0].children![0].type === 'text' && state.ast[0].children![0].text === '';

    return (
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
        onBeforeInput={handleBeforeInput}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onFocus={handleFocus}
        onBlur={handleBlur}
        role="textbox"
        tabIndex={0}
        aria-label="Block content"
        aria-multiline="false"
      >
        <InlineContentRenderer name={serializedAST} />
        {isEmpty && placeholder && (
          <span className="custom-inline-editor__placeholder" aria-hidden="true">
            {placeholder}
          </span>
        )}
      </div>
    );
  }),
);
