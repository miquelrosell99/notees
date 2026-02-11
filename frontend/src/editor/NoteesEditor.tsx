/**
 * NoteesEditor — The main Lexical editor component for Notees.
 *
 * This is a projection-based editor. It does NOT own hierarchy.
 * The NodeGraphRuntime is the source of truth. This editor renders
 * a flat list of NodeBlockNodes with depth metadata.
 *
 * Supports multiple simultaneous instances (main editor, sidebar cards, etc.)
 */

import { useCallback, useMemo, useId, type JSX } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';

import { notesEditorTheme } from './theme';
import { NodeBlockNode } from './nodes/NodeBlockNode';
import { NodePillNode } from './nodes/NodePillNode';
import { NodeBlockHeadingNode } from './nodes/NodeBlockHeadingNode';
import { NodeBlockCodeNode } from './nodes/NodeBlockCodeNode';
import { NodeBlockTableCellNode } from './nodes/NodeBlockTableCellNode';

import { NodeBlockPlugin } from './plugins/NodeBlockPlugin';
import { NodePillPlugin } from './plugins/NodePillPlugin';
import { DragDropPlugin } from './plugins/DragDropPlugin';
import { SelectionPlugin } from './plugins/SelectionPlugin';
import { CollapsePlugin } from './plugins/CollapsePlugin';
import { FormattingPlugin } from './plugins/FormattingPlugin';
import { SlashCommandPlugin, type TriggerType } from './plugins/SlashCommandPlugin';
import { FloatingToolbarPlugin } from './plugins/FloatingToolbarPlugin';

import { getNodeGraphRuntime } from '../runtime/NodeGraphRuntime';
import type { ContentAST, ViewMode } from '../runtime/types';

import './NoteesEditor.css';

// ─── Props ────────────────────────────────────────────────────────

export interface NoteesEditorProps {
  /** Unique editor instance ID */
  editorId?: string;
  /** Root block ID to project from */
  rootBlockId: string;
  /** View mode affects rendering style */
  viewMode?: ViewMode;
  /** Read-only mode */
  readOnly?: boolean;
  /** Called when a node pill is clicked */
  onNavigateToNode?: (linkId: string) => void;
  /** Called on escape */
  onEscape?: () => void;
  /** Called when selection changes (block IDs) */
  onSelectionChange?: (blockIds: string[]) => void;
  /** Custom trigger popup renderer */
  renderTriggerPopup?: (state: {
    type: TriggerType;
    query: string;
    position: { top: number; left: number };
    onSelect: (value: string, metadata?: any) => void;
    onClose: () => void;
  }) => JSX.Element | null;
  /** Called when any block's content changes (for API persistence) */
  onContentChange?: (blockId: string, content: string) => void;
  /** Custom class name */
  className?: string;
  /** Placeholder text */
  placeholder?: string;
}

// ─── Component ────────────────────────────────────────────────────

export function NoteesEditor({
  editorId: externalEditorId,
  rootBlockId,
  viewMode = 'list',
  readOnly = false,
  onNavigateToNode,
  onEscape,
  onSelectionChange,
  onContentChange: onContentChangeCallback,
  renderTriggerPopup,
  className,
  placeholder = 'Type / for commands…',
}: NoteesEditorProps): JSX.Element {
  const generatedId = useId();
  const editorId = externalEditorId || `editor-${generatedId}`;

  // ─── Lexical config ────────────────────────────────────────

  const initialConfig = useMemo(() => ({
    namespace: `NoteesEditor-${editorId}`,
    theme: notesEditorTheme,
    nodes: [
      NodeBlockNode,
      NodePillNode,
      NodeBlockHeadingNode,
      NodeBlockCodeNode,
      NodeBlockTableCellNode,
    ],
    editable: !readOnly,
    onError: (error: Error) => {
      console.error(`[NoteesEditor ${editorId}]`, error);
    },
  }), [editorId, readOnly]);

  // ─── Handlers ──────────────────────────────────────────────

  const handleContentChange = useCallback((blockId: string, contentAST: ContentAST) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({
      type: 'update_content',
      blockId,
      contentAST,
    });
    // Notify parent for API persistence
    if (onContentChangeCallback) {
      // Serialize AST to plain text for API
      const text = contentAST
        .map(node => {
          if ('text' in node) return node.text;
          if ('children' in node) return node.children.map((c: any) => c.text ?? '').join('');
          return '';
        })
        .join('\n');
      onContentChangeCallback(blockId, text);
    }
  }, [onContentChangeCallback]);

  const handleBlockCreate = useCallback((parentId: string, afterBlockId: string, newBlockId: string) => {
    const runtime = getNodeGraphRuntime();
    const node = runtime.getNode(afterBlockId);
    runtime.applyIntent({
      type: 'create_block',
      parentId: node?.parentId || parentId,
      afterBlockId,
      blockId: newBlockId,
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
    });
  }, []);

  const handleBlockMerge = useCallback((sourceBlockId: string, targetBlockId: string) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({
      type: 'merge_blocks',
      sourceBlockId,
      targetBlockId,
    });
  }, []);

  const handleIndent = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'indent_block', blockId });
  }, []);

  const handleOutdent = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'outdent_block', blockId });
  }, []);

  const handlePillClick = useCallback((linkId: string) => {
    onNavigateToNode?.(linkId);
  }, [onNavigateToNode]);

  const handlePillRemove = useCallback((_linkId: string) => {
    // Content change will be picked up by the update listener
  }, []);

  // ─── Render ────────────────────────────────────────────────

  const editorClassName = [
    'notees-editor',
    `notees-editor--${viewMode}`,
    readOnly ? 'notees-editor--readonly' : '',
    className || '',
  ].filter(Boolean).join(' ');

  return (
    <div className={editorClassName}>
      <LexicalComposer initialConfig={initialConfig}>
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="notees-editor-content"
              aria-label="Note editor"
            />
          }
          placeholder={
            <div className="notees-editor-placeholder">{placeholder}</div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />

        {/* Core plugins */}
        <HistoryPlugin />
        <FormattingPlugin />
        <CollapsePlugin />

        {/* NodeBlock projection plugin */}
        <NodeBlockPlugin
          editorId={editorId}
          rootBlockId={rootBlockId}
          onContentChange={handleContentChange}
          onBlockCreate={handleBlockCreate}
          onBlockMerge={handleBlockMerge}
          onIndent={handleIndent}
          onOutdent={handleOutdent}
          onEscape={onEscape}
          readOnly={readOnly}
        />

        {/* NodePill plugin */}
        <NodePillPlugin
          onPillClick={handlePillClick}
          onPillRemove={handlePillRemove}
        />

        {/* Drag & drop */}
        <DragDropPlugin
          editorId={editorId}
          readOnly={readOnly}
        />

        {/* Selection */}
        <SelectionPlugin
          editorId={editorId}
          onSelectionChange={onSelectionChange}
        />

        {/* Slash commands and triggers */}
        <SlashCommandPlugin
          renderPopup={renderTriggerPopup}
          onLinkSelect={handlePillClick}
        />

        {/* Floating toolbar */}
        <FloatingToolbarPlugin />
      </LexicalComposer>
    </div>
  );
}
