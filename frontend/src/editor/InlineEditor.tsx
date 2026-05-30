/**
 * InlineEditor — Minimal Lexical instance for a single block's inline content.
 *
 * One InlineEditor per block. No BlockNode. No BlockPlugin.
 * Only handles text formatting, inline links (pills), and math.
 *
 * Keyboard events (Enter, Backspace, Tab, Arrows) are handled externally
 * by the BlockList container via editorFocusStore + imperative handle.
 */

import {
  useCallback,
  useMemo,
  useRef,
  useEffect,
  forwardRef,
  useImperativeHandle,
  type JSX,
} from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  ParagraphNode,
  TextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $createParagraphNode,
  type LexicalEditor,
  type ElementNode,
} from 'lexical';
import { notesEditorTheme } from './theme';
import './InlineEditor.css';
import '@/styles/inline-link.css';
import { InlineLinkNode } from './nodes/InlineLinkNode';
import { MathNode } from './nodes/MathNode';
import { populateInlineContent, extractInlineContent } from './inlineContentPopulation';
import { serializeContentAST } from './editorConfig';
import { useEditorFocusStore } from '../stores/editorFocusStore';
import { useInlineEditorRegistry } from '../stores/inlineEditorRegistry';
import { useLivePresenceStore } from '../stores/livePresenceStore';
import { liveSyncManager } from '../collab/LiveSyncManager';
import { NodeLinkPlugin } from './plugins/NodeLinkPlugin';
import { TriggerPlugin } from './plugins/TriggerPlugin';
import { CustomCaretPlugin } from './plugins/CustomCaretPlugin';
import { InlineEditorKeysPlugin } from './plugins/InlineEditorKeysPlugin';
import { FloatingToolbarPlugin } from './plugins/FloatingToolbarPlugin';
import { InlineCopyPastePlugin } from './plugins/InlineCopyPastePlugin';
import type { ContentAST } from '../runtime/types';
import type { EditorState } from 'lexical';

// ─── Types ────────────────────────────────────────────────────────

export interface InlineEditorHandle {
  /** Focus the editor. */
  focus: () => void;
  /** Blur the editor. */
  blur: () => void;
  /** Get cursor position category relative to the block content. */
  getCursorPosition: () => 'start' | 'end' | 'middle' | 'empty';
  /** Get exact cursor offset (anchor offset) for split_block intent. */
  getCursorOffset: () => number;
}

interface InlineEditorProps {
  /** Unique block ID (runtime GraphNode ID). */
  blockId: string;
  /** Initial content AST. */
  initialContentAST: ContentAST;
  /** Whether the editor is read-only. */
  readOnly?: boolean;
  /** Placeholder text when empty. */
  placeholder?: string;
  /** Called when content changes (debounced by parent). */
  onContentChange?: (blockId: string, content: string) => void;
  /** Called when a pill is clicked for navigation. */
  onPillClick?: (linkId: string, refType: 'node' | 'class' | 'url' | 'embed' | 'broken') => void;
  /** Called when a pill is removed. */
  onPillRemove?: (linkId: string) => void;
  /** Called when a class should be added via + trigger. */
  onAddClass?: (blockServerId: number, classId: number) => void;
  /** Called when a slash command is selected. */
  onSlashCommand?: (commandId: string, blockServerId: number | undefined) => void;
  /** Called when a template is selected. */
  onTemplateInstantiate?: (templateNodeId: number, blockServerId: number | undefined) => void;
  /** Class IDs to pre-filter template picker. */
  templateClassFilters?: number[];
  /** Called on Enter (block creation / split). */
  onEnter?: () => void;
  /** Called on Backspace at start of block (merge with previous). */
  onBackspaceAtStart?: () => void;
  /** Called on Delete at end of block (merge with next). */
  onDeleteAtEnd?: () => void;
  /** Called on Tab / Shift+Tab (indent / outdent). */
  onTab?: (shift: boolean) => void;
  /** Called on Escape (blur editor and select block). */
  onEscape?: () => void;
  /** UUID of the containing page (for live sync focus tracking). */
  pageUuid?: string;
}

// ─── Component ────────────────────────────────────────────────────

export const InlineEditor = forwardRef<InlineEditorHandle, InlineEditorProps>(
  function InlineEditor(
    {
      blockId,
      initialContentAST,
      readOnly = false,
      placeholder = '',
      onContentChange,
      onPillClick,
      onPillRemove,
      onAddClass,
      onSlashCommand,
      onTemplateInstantiate,
      templateClassFilters,
      onEnter,
      onBackspaceAtStart,
      onDeleteAtEnd,
      onTab,
      onEscape,
      pageUuid,
    },
    ref,
  ): JSX.Element {
    const editorRef = useRef<ReturnType<typeof useLexicalComposerContext>[0] | null>(null);
    const focusBlock = useEditorFocusStore((s) => s.focusBlock);
    const blurBlock = useEditorFocusStore((s) => s.blurBlock);

    const initialConfig = useMemo(
      () => ({
        namespace: `InlineEditor-${blockId}`,
        theme: notesEditorTheme,
        nodes: [ParagraphNode, TextNode, InlineLinkNode, MathNode],
        onError: (error: Error) => {
          console.error(`[InlineEditor ${blockId}] Lexical error:`, error);
        },
        editable: !readOnly,
        editorState: () => {
          const root = $getRoot();
          root.clear();
          const paragraph = $createParagraphNode();
          populateInlineContent(paragraph, initialContentAST);
          root.append(paragraph);
        },
      }),
      [blockId, readOnly, initialContentAST],
    );

    // ─── Change handler ───────────────────────────────────────────

    const handleChange = useCallback(
      (editorState: EditorState) => {
        if (readOnly) return;
        editorState.read(() => {
          const root = $getRoot();
          const paragraph = root.getFirstChild();
          if (!paragraph) return;
          const ast = extractInlineContent(paragraph as ElementNode);
          onContentChange?.(blockId, serializeContentAST(ast));
        });
      },
      [blockId, readOnly, onContentChange],
    );

    // ─── Imperative handle ────────────────────────────────────────

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          editorRef.current?.focus();
        },
        blur: () => {
          editorRef.current?.blur();
        },
        getCursorPosition: () => {
          let position: 'start' | 'end' | 'middle' | 'empty' = 'empty';
          editorRef.current?.getEditorState().read(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) {
              position = 'empty';
              return;
            }
            const anchor = selection.anchor;
            const root = $getRoot();
            const paragraph = root.getFirstChild();
            if (!paragraph) {
              position = 'empty';
              return;
            }
            const textContent = paragraph.getTextContent();
            const offset = anchor.offset;

            if (textContent === '' || textContent === '\u200B') {
              position = 'empty';
            } else if (offset === 0) {
              position = 'start';
            } else if (offset >= textContent.length) {
              position = 'end';
            } else {
              position = 'middle';
            }
          });
          return position;
        },
        getCursorOffset: () => {
          let offset = 0;
          editorRef.current?.getEditorState().read(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              offset = selection.anchor.offset;
            }
          });
          return offset;
        },
      }),
      [],
    );

    // ─── Focus / blur ─────────────────────────────────────────────

    const handleFocus = useCallback(() => {
      focusBlock(blockId);
      if (pageUuid) {
        liveSyncManager.sendFocus(blockId);
        useLivePresenceStore.getState().setLocalFocus(pageUuid, blockId);
      }
    }, [blockId, focusBlock, pageUuid]);

    const handleBlur = useCallback(() => {
      blurBlock(blockId);
      if (pageUuid) {
        liveSyncManager.sendBlur(blockId);
        useLivePresenceStore.getState().setLocalFocus(pageUuid, null);
      }
    }, [blurBlock, blockId, pageUuid]);

    // ─── Render ───────────────────────────────────────────────────

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <InlineEditorInner
          blockId={blockId}
          readOnly={readOnly}
          placeholder={placeholder}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onPillClick={onPillClick}
          onPillRemove={onPillRemove}
          onAddClass={onAddClass}
          onSlashCommand={onSlashCommand}
          onTemplateInstantiate={onTemplateInstantiate}
          templateClassFilters={templateClassFilters}
          onEnter={onEnter}
          onBackspaceAtStart={onBackspaceAtStart}
          onDeleteAtEnd={onDeleteAtEnd}
          onTab={onTab}
          onEscape={onEscape}
          onContentChange={onContentChange}
          editorRef={editorRef}
        />
      </LexicalComposer>
    );
  },
);

// ─── Inner component (has access to LexicalComposerContext) ───────

interface InlineEditorInnerProps {
  blockId: string;
  readOnly: boolean;
  placeholder: string;
  onChange: (editorState: EditorState, editor: LexicalEditor) => void;
  onFocus: () => void;
  onBlur: () => void;
  onPillClick?: InlineEditorProps['onPillClick'];
  onPillRemove?: InlineEditorProps['onPillRemove'];
  onAddClass?: InlineEditorProps['onAddClass'];
  onSlashCommand?: InlineEditorProps['onSlashCommand'];
  onTemplateInstantiate?: InlineEditorProps['onTemplateInstantiate'];
  templateClassFilters?: InlineEditorProps['templateClassFilters'];
  onEnter?: InlineEditorProps['onEnter'];
  onBackspaceAtStart?: InlineEditorProps['onBackspaceAtStart'];
  onDeleteAtEnd?: InlineEditorProps['onDeleteAtEnd'];
  onTab?: InlineEditorProps['onTab'];
  onEscape?: InlineEditorProps['onEscape'];
  onContentChange?: InlineEditorProps['onContentChange'];
  editorRef: React.MutableRefObject<LexicalEditor | null>;
}

function InlineEditorInner({
  blockId,
  readOnly,
  placeholder,
  onChange,
  onFocus,
  onBlur,
  onPillClick,
  onPillRemove,
  onAddClass,
  onSlashCommand,
  onTemplateInstantiate,
  templateClassFilters,
  onEnter,
  onBackspaceAtStart,
  onDeleteAtEnd,
  onTab,
  onEscape,
  onContentChange,
  editorRef,
}: InlineEditorInnerProps): JSX.Element {
  const [editor] = useLexicalComposerContext();

  // Expose editor instance to parent via ref
  useEffect(() => {
    editorRef.current = editor;
  }, [editor, editorRef]);

  // Register/unregister in the global inline editor registry (for find/replace)
  useEffect(() => {
    useInlineEditorRegistry.getState().register(blockId, editor);
    return () => {
      useInlineEditorRegistry.getState().unregister(blockId);
    };
  }, [blockId, editor]);

  return (
    <div className="inline-editor" data-block-id={blockId}>
      <RichTextPlugin
        contentEditable={
          <ContentEditable
            className="inline-editor__content node-block-content"
            onFocus={onFocus}
            onBlur={onBlur}
            aria-label="Block content"
          />
        }
        placeholder={
          placeholder ? (
            <div className="inline-editor__placeholder">{placeholder}</div>
          ) : null
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <OnChangePlugin onChange={onChange} />
      <NodeLinkPlugin onPillClick={onPillClick} onPillRemove={onPillRemove} />
      {!readOnly && onEnter && onBackspaceAtStart && onDeleteAtEnd && onTab && (
        <InlineEditorKeysPlugin
          onEnter={onEnter}
          onBackspaceAtStart={onBackspaceAtStart}
          onDeleteAtEnd={onDeleteAtEnd}
          onTab={onTab}
          onEscape={onEscape}
        />
      )}
      {!readOnly && <FloatingToolbarPlugin />}
      {!readOnly && <InlineCopyPastePlugin blockId={blockId} onContentChange={onContentChange} />}
      {!readOnly && <CustomCaretPlugin readOnly={readOnly} />}
      {!readOnly && (
        <TriggerPlugin
          blockId={blockId}
          onAddClass={onAddClass}
          onSlashCommand={onSlashCommand}
          onTemplateInstantiate={onTemplateInstantiate}
          templateClassFilters={templateClassFilters}
        />
      )}
    </div>
  );
}
