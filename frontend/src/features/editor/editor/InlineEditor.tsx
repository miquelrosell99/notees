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
  useLayoutEffect,
  forwardRef,
  useImperativeHandle,
  memo,
  type JSX,
} from 'react';

import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  ParagraphNode,
  TextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $isLineBreakNode,
  type LexicalEditor,
  type ElementNode,
} from 'lexical';
import { notesEditorTheme } from './theme';
import './InlineEditor.css';
import '@/styles/inline-link.css';
import { InlineLinkNode, $isInlineLinkNode } from './nodes/InlineLinkNode';
import { MathNode, $isMathNode } from './nodes/MathNode';
import { extractInlineContent } from './inlineContentPopulation';
import { serializeContentAST } from './editorConfig';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { useInlineEditorRegistry } from '@/stores/inlineEditorRegistry';
import { useLivePresenceStore, liveSyncManager } from '@/features/collab';
import {
  clearActiveEditor,
  setActiveEditor,
} from './activeEditorRegistry';
import { reportEditorFocus } from './mobileEditorBridge';
import { NodeLinkPlugin } from './plugins/NodeLinkPlugin';
import { TriggerPlugin } from './plugins/TriggerPlugin';
import { CustomCaretPlugin } from './plugins/CustomCaretPlugin';
import { InlineEditorKeysPlugin } from './plugins/InlineEditorKeysPlugin';
import { FloatingToolbarPlugin } from './plugins/FloatingToolbarPlugin';
import { InlineCopyPastePlugin } from './plugins/InlineCopyPastePlugin';
import { EditablePlugin } from './plugins/EditablePlugin';
import { SyncedContentPlugin } from './plugins/SyncedContentPlugin';
import type { ContentAST } from '@/runtime/types';
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
  onPillClick?: (linkId: string, refType: 'node' | 'class' | 'url' | 'embed' | 'broken' | 'user') => void;
  /** Called when a pill is removed. */
  onPillRemove?: (linkId: string) => void;
  /** Called when a class should be added via + trigger. */
  onAddClass?: (blockServerId: number, classId: number) => void;
  /** Called when a slash command is selected. */
  onSlashCommand?: (commandId: string, blockServerId: number | undefined) => void;
  /** Called when an image is pasted into the block. */
  onPasteImage?: (blockServerId: number, file: File, hasContent: boolean) => void;
  /** Called when a template is selected. */
  onTemplateInstantiate?: (templateNodeId: number, blockServerId: number | undefined) => void;
  /** Class IDs to pre-filter template picker. */
  templateClassFilters?: number[];
  /** Called on Enter (block creation / split). */
  onEnter?: () => void;
  /** Called on Ctrl+Enter (task cycle, etc.). */
  onCtrlEnter?: () => void;
  /** Called on Backspace at start of block (merge with previous). */
  onBackspaceAtStart?: () => void;
  /** Called on Delete at end of block (merge with next). */
  onDeleteAtEnd?: () => void;
  /** Called on Escape (blur editor and select block). */
  onEscape?: () => void;
  /** UUID of the containing node (for live sync focus tracking). */
  nodeUuid?: string;
  /** Whether this editor belongs to a page block (applies page title styling). */
  isPage?: boolean;
  /** Whether the containing block has a node color applied. */
  hasNodeColor?: boolean;
  /** Whether this editor is rendered inside a card context. */
  inCard?: boolean;
  /** Whether this editor is a card title block (single-line title styling). */
  cardTitle?: boolean;
  /** Compact list-view size context (e.g. 'sm' for small list view). */
  listSize?: 'sm' | 'md';
  /** Whether this editor is rendered inside a property text block editor. */
  inPropertyEditor?: boolean;
}

// ─── Component ────────────────────────────────────────────────────

export const InlineEditor = memo(
  forwardRef<InlineEditorHandle, InlineEditorProps>(function InlineEditor(
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
      onPasteImage,
      onTemplateInstantiate,
      templateClassFilters,
      onEnter,
      onCtrlEnter,
      onBackspaceAtStart,
      onDeleteAtEnd,
      onEscape,
      nodeUuid,
      isPage,
      hasNodeColor,
      inCard,
      cardTitle,
      listSize,
      inPropertyEditor,
    },
    ref,
  ): JSX.Element {
    const editorRef = useRef<ReturnType<typeof useLexicalComposerContext>[0] | null>(null);
    const focusBlock = useEditorFocusStore((s) => s.focusBlock);
    const blurBlock = useEditorFocusStore((s) => s.blurBlock);

    // Stable Lexical configuration: content is hydrated imperatively by
    // SyncedContentPlugin so that TanStack Query refetches never remount the
    // composer and wipe focus / selection / undo state.
    const initialConfig = useMemo(
      () => ({
        namespace: `InlineEditor-${blockId}`,
        theme: notesEditorTheme,
        nodes: [ParagraphNode, TextNode, InlineLinkNode, MathNode],
        onError: (error: Error) => {
          console.error(`[InlineEditor ${blockId}] Lexical error:`, error);
        },
        editable: !readOnly,
      }),
      [blockId, readOnly],
    );

    // ─── Change handler ───────────────────────────────────────────

    const typingSentAtRef = useRef<number>(0);
    const idleReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lockReleasedEarlyRef = useRef<boolean>(false);

    const clearIdleReleaseTimer = useCallback(() => {
      if (idleReleaseTimerRef.current) {
        clearTimeout(idleReleaseTimerRef.current);
        idleReleaseTimerRef.current = null;
      }
    }, []);

    const scheduleIdleRelease = useCallback(() => {
      clearIdleReleaseTimer();
      if (!nodeUuid) return;
      idleReleaseTimerRef.current = setTimeout(() => {
        idleReleaseTimerRef.current = null;
        lockReleasedEarlyRef.current = true;
        liveSyncManager.sendRelease(blockId);
      }, 3000);
    }, [blockId, clearIdleReleaseTimer, nodeUuid]);

    const handleChange = useCallback(
      (editorState: EditorState, _editor: LexicalEditor, tags: Set<string>) => {
        if (readOnly) return;
        // Ignore updates generated by SyncedContentPlugin so we don't re-save
        // content that just came from the prop / server.
        if (tags.has('synced-content')) return;

        // Re-acquire lock if it was released early due to idle typing.
        if (nodeUuid && lockReleasedEarlyRef.current) {
          lockReleasedEarlyRef.current = false;
          liveSyncManager.sendFocus(blockId);
        }

        // Throttle typing presence events to once per second.
        const now = Date.now();
        if (nodeUuid && now - typingSentAtRef.current > 1000) {
          typingSentAtRef.current = now;
          liveSyncManager.sendTyping(blockId);
        }

        // Release the lock after a few seconds of inactivity so another user
        // can pick it up without waiting for the server-side timeout.
        scheduleIdleRelease();

        editorState.read(() => {
          const root = $getRoot();
          const paragraph = root.getFirstChild();
          if (!paragraph) return;
          const ast = extractInlineContent(paragraph as ElementNode);
          onContentChange?.(blockId, serializeContentAST(ast));
        });
      },
      [blockId, nodeUuid, readOnly, onContentChange, scheduleIdleRelease],
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

            // If there's an active range selection (not just a collapsed cursor),
            // treat it as middle so the block is split after deleting the selection.
            if (!selection.isCollapsed()) {
              position = 'middle';
              return;
            }

            const anchor = selection.anchor;
            const root = $getRoot();
            const paragraph = root.getFirstChild();
            if (!paragraph) {
              position = 'empty';
              return;
            }

            // Cast to ElementNode for descendant/children methods
            const paragraphEl = paragraph as ElementNode;
            const children = paragraphEl.getChildren();
            const hasMeaningfulContent = children.some((child) => {
              if ($isTextNode(child)) {
                const text = child.getTextContent();
                return text !== '' && text !== '\u200B';
              }
              return true;
            });

            if (!hasMeaningfulContent) {
              position = 'empty';
              return;
            }

            // Check absolute start (anchor is at the very first position)
            const firstDescendant = paragraphEl.getFirstDescendant();
            if (anchor.type === 'text') {
              if (anchor.getNode() === firstDescendant && anchor.offset === 0) {
                position = 'start';
                return;
              }
            } else {
              if (anchor.getNode() === paragraphEl && anchor.offset === 0) {
                position = 'start';
                return;
              }
            }

            // Check absolute end (anchor is at the very last position)
            const lastDescendant = paragraphEl.getLastDescendant();
            if (anchor.type === 'text') {
              const anchorNode = anchor.getNode();
              if (anchorNode === lastDescendant && anchor.offset >= anchorNode.getTextContent().length) {
                position = 'end';
                return;
              }
            } else {
              if (anchor.getNode() === paragraphEl && anchor.offset >= paragraphEl.getChildrenSize()) {
                position = 'end';
                return;
              }
            }

            position = 'middle';
          });
          return position;
        },
        getCursorOffset: () => {
          let offset = 0;
          editorRef.current?.getEditorState().read(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;

            const anchor = selection.anchor;
            const anchorNode = anchor.getNode();
            const root = $getRoot();
            const paragraph = root.getFirstChild();
            if (!paragraph) return;

            const paragraphEl = paragraph as ElementNode;
            const children = paragraphEl.getChildren();

            // Element anchor (cursor is on the paragraph boundary between children)
            if (anchor.type === 'element') {
              for (let i = 0; i < Math.min(anchor.offset, children.length); i++) {
                const child = children[i];
                if ($isTextNode(child) && child.getTextContent() === '\u200B') continue;
                if ($isTextNode(child)) {
                  offset += child.getTextContent().length;
                } else if ($isInlineLinkNode(child)) {
                  offset += 1;
                } else if ($isMathNode(child)) {
                  offset += 1;
                } else if ($isLineBreakNode(child)) {
                  offset += 1;
                } else {
                  offset += child.getTextContent().length;
                }
              }
              return;
            }

            // Text anchor — walk children until we hit the anchor node
            for (const child of children) {
              if (child === anchorNode || child.getKey() === anchorNode.getKey()) {
                if (!($isTextNode(anchorNode) && anchorNode.getTextContent() === '\u200B')) {
                  const text = anchorNode.getTextContent();
                  if (text !== '\u200B') {
                    offset += anchor.offset;
                  }
                }
                break;
              }

              if ($isTextNode(child) && child.getTextContent() === '\u200B') continue;
              if ($isTextNode(child)) {
                offset += child.getTextContent().length;
              } else if ($isInlineLinkNode(child)) {
                offset += 1;
              } else if ($isMathNode(child)) {
                offset += 1;
              } else if ($isLineBreakNode(child)) {
                offset += 1;
              } else {
                offset += child.getTextContent().length;
              }
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
      lockReleasedEarlyRef.current = false;
      if (nodeUuid) {
        liveSyncManager.sendFocus(blockId);
        useLivePresenceStore.getState().setLocalFocus(nodeUuid, blockId);
      }
    }, [blockId, focusBlock, nodeUuid]);

    const handleBlur = useCallback(() => {
      blurBlock(blockId);
      clearIdleReleaseTimer();
      lockReleasedEarlyRef.current = false;
      if (nodeUuid) {
        // Don't release the live-sync lock while a trigger popup (or any editor
        // popup) is open — the user is still editing that block through the
        // popup. Releasing it immediately causes spurious "edited by someone
        // else" conflicts when the debounced save fires.
        if (!useEditorFocusStore.getState().popupOpen) {
          liveSyncManager.sendBlur(blockId);
        }
        useLivePresenceStore.getState().setLocalFocus(nodeUuid, null);
      }
    }, [blurBlock, blockId, clearIdleReleaseTimer, nodeUuid]);

    // ─── Render ───────────────────────────────────────────────────

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <InlineEditorInner
          blockId={blockId}
          initialContentAST={initialContentAST}
          readOnly={readOnly}
          placeholder={placeholder}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onPillClick={onPillClick}
          onPillRemove={onPillRemove}
          onAddClass={onAddClass}
          onSlashCommand={onSlashCommand}
          onPasteImage={onPasteImage}
          onTemplateInstantiate={onTemplateInstantiate}
          templateClassFilters={templateClassFilters}
          onEnter={onEnter}
          onCtrlEnter={onCtrlEnter}
          onBackspaceAtStart={onBackspaceAtStart}
          onDeleteAtEnd={onDeleteAtEnd}
          onEscape={onEscape}
          editorRef={editorRef}
          isPage={isPage}
          hasNodeColor={hasNodeColor}
          inCard={inCard}
          cardTitle={cardTitle}
          listSize={listSize}
          inPropertyEditor={inPropertyEditor}
        />
      </LexicalComposer>
    );
  },
));

// ─── Inner component (has access to LexicalComposerContext) ───────

interface InlineEditorInnerProps {
  blockId: string;
  initialContentAST: ContentAST;
  readOnly: boolean;
  placeholder: string;
  onChange: (editorState: EditorState, editor: LexicalEditor, tags: Set<string>) => void;
  onFocus: () => void;
  onBlur: () => void;
  onPillClick?: InlineEditorProps['onPillClick'];
  onPillRemove?: InlineEditorProps['onPillRemove'];
  onAddClass?: InlineEditorProps['onAddClass'];
  onSlashCommand?: InlineEditorProps['onSlashCommand'];
  onPasteImage?: InlineEditorProps['onPasteImage'];
  onTemplateInstantiate?: InlineEditorProps['onTemplateInstantiate'];
  templateClassFilters?: InlineEditorProps['templateClassFilters'];
  onEnter?: InlineEditorProps['onEnter'];
  onCtrlEnter?: InlineEditorProps['onCtrlEnter'];
  onBackspaceAtStart?: InlineEditorProps['onBackspaceAtStart'];
  onDeleteAtEnd?: InlineEditorProps['onDeleteAtEnd'];
  onEscape?: InlineEditorProps['onEscape'];
  editorRef: React.MutableRefObject<LexicalEditor | null>;
  isPage?: boolean;
  hasNodeColor?: boolean;
  inCard?: boolean;
  cardTitle?: boolean;
  listSize?: 'sm' | 'md';
  inPropertyEditor?: boolean;
}

function InlineEditorInner({
  blockId,
  initialContentAST,
  readOnly,
  placeholder,
  onChange,
  onFocus,
  onBlur,
  onPillClick,
  onPillRemove,
  onAddClass,
  onSlashCommand,
  onPasteImage,
  onTemplateInstantiate,
  templateClassFilters,
  onEnter,
  onCtrlEnter,
  onBackspaceAtStart,
  onDeleteAtEnd,
  onEscape,
  editorRef,
  isPage,
  hasNodeColor,
  inCard,
  cardTitle,
  listSize,
  inPropertyEditor,
}: InlineEditorInnerProps): JSX.Element {
  const [editor] = useLexicalComposerContext();

  // Expose editor instance to parent via ref
  useLayoutEffect(() => {
    editorRef.current = editor;
  }, [editor, editorRef]);

  // Track the active editor globally and report focus changes to the native shell.
  const handleFocus = useCallback(() => {
    setActiveEditor(editor);
    reportEditorFocus(true);
    onFocus();
  }, [editor, onFocus]);

  const handleBlur = useCallback(() => {
    clearActiveEditor(editor);
    reportEditorFocus(false);
    onBlur();
  }, [editor, onBlur]);

  // Register/unregister in the global inline editor registry (for find/replace)
  useEffect(() => {
    useInlineEditorRegistry.getState().register(blockId, editor);
    return () => {
      useInlineEditorRegistry.getState().unregister(blockId);
    };
  }, [blockId, editor]);

  return (
    <div
      className="inline-editor"
      data-block-id={blockId}
      data-page={isPage || undefined}
      data-has-node-color={hasNodeColor || undefined}
      data-in-card={inCard || undefined}
      data-card-title={cardTitle || undefined}
      data-list-size={listSize || undefined}
      data-property-editor={inPropertyEditor || undefined}
    >
      <SyncedContentPlugin contentAST={initialContentAST} readOnly={readOnly} />
      <RichTextPlugin
        contentEditable={
          <ContentEditable
            className="inline-editor__content node-block-content"
            onFocus={handleFocus}
            onBlur={handleBlur}
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
      <OnChangePlugin onChange={onChange} />
      <NodeLinkPlugin onPillClick={onPillClick} onPillRemove={onPillRemove} />
      {!readOnly && (
        <InlineEditorKeysPlugin
          onEnter={onEnter}
          onCtrlEnter={onCtrlEnter}
          onBackspaceAtStart={onBackspaceAtStart}
          onDeleteAtEnd={onDeleteAtEnd}
          onEscape={onEscape}
        />
      )}
      <EditablePlugin readOnly={readOnly} />
      {!readOnly && <FloatingToolbarPlugin />}
      {!readOnly && <InlineCopyPastePlugin blockId={blockId} onPasteImage={onPasteImage} />}
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
