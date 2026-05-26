import { memo, useMemo, useCallback, type JSX } from 'react';

import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';

import { notesEditorTheme } from '@/editor/theme';
import { EDITOR_NODES, serializeContentAST } from '@/editor/editorConfig';
import { BlockPlugin } from '@/editor/plugins/BlockPlugin';
import { NodeLinkPlugin } from '@/editor/plugins/NodeLinkPlugin';
import { DragDropPlugin } from '@/editor/plugins/DragDropPlugin';
import { CollapsePlugin } from '@/editor/plugins/CollapsePlugin';
import { FormattingPlugin } from '@/editor/plugins/FormattingPlugin';
import { TriggerPlugin } from '@/editor/plugins/TriggerPlugin';
import { FloatingToolbarPlugin } from '@/editor/plugins/FloatingToolbarPlugin';
import { ContextMenuPlugin } from '@/editor/plugins/ContextMenuPlugin';
import { BlurOnClickOutsidePlugin } from '@/editor/plugins/BlurOnClickOutsidePlugin';
import { PasteImagePlugin } from '@/editor/plugins/PasteImagePlugin';

import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import type { ContentAST } from '@/runtime/types';

export interface CardChildrenEditorProps {
  rootBlockId: string;
  readOnly: boolean;
  onContentChange?: (blockId: string, content: string) => void;
  onNavigateToNode?: (linkId: string) => void;
  onOpenInSidebar?: (blockId: string) => void;
  onAddClass?: (blockId: number, classId: number) => void;
  onSlashCommand?: (commandId: string, blockServerId: number | undefined) => void;
  onPasteImage?: (blockServerId: number, file: File, hasContent: boolean) => void;
}

/**
 * ONE Lexical editor for the children of a card's root block.
 * Uses includeRoot=false (default) so only children are projected.
 */
export const CardChildrenEditor = memo(function CardChildrenEditor({
  rootBlockId,
  readOnly,
  onContentChange,
  onNavigateToNode,
  onOpenInSidebar,
  onAddClass,
  onSlashCommand,
  onPasteImage,
}: CardChildrenEditorProps): JSX.Element {
  const editorId = `card-children-${rootBlockId}`;

  const initialConfig = useMemo(() => ({
    namespace: `CardChildren-${rootBlockId}`,
    theme: notesEditorTheme,
    nodes: EDITOR_NODES,
    editable: !readOnly,
    editorState: null,
    onError: (error: Error) => {
      console.error(`[CardChildrenEditor ${rootBlockId}]`, error);
    },
  }), [rootBlockId, readOnly]);

  const handleContentChange = useCallback((blockId: string, contentAST: ContentAST) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'update_content', blockId, contentAST });
    onContentChange?.(blockId, serializeContentAST(contentAST));
  }, [onContentChange]);

  const handleBlockMerge = useCallback((sourceBlockId: string, targetBlockId: string) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'merge_blocks', sourceBlockId, targetBlockId });
  }, []);

  const handleBlockDelete = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'delete_block', blockId });
  }, []);

  const handleIndent = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'indent_block', blockId });
  }, []);

  const handleOutdent = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'outdent_block', blockId });
  }, []);

  const handleMoveUp = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'move_up', blockId });
  }, []);

  const handleMoveDown = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'move_down', blockId });
  }, []);

  const handlePillClick = useCallback((linkId: string) => {
    onNavigateToNode?.(linkId);
  }, [onNavigateToNode]);

  return (
    <div className="node-card__children">
      <LexicalComposer initialConfig={initialConfig}>
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="node-card__children-editable"
              aria-label="Card content"
              spellCheck={false}
            />
          }
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <FormattingPlugin />
        <CollapsePlugin />
        <BlockPlugin
          editorId={editorId}
          rootBlockId={rootBlockId}
          onContentChange={handleContentChange}
          onBlockMerge={handleBlockMerge}
          onBlockDelete={handleBlockDelete}
          onIndent={handleIndent}
          onOutdent={handleOutdent}
          onMoveUp={handleMoveUp}
          onMoveDown={handleMoveDown}
          readOnly={readOnly}
        />
        <NodeLinkPlugin
          onPillClick={handlePillClick}
          onPillRemove={() => {}}
        />
        <DragDropPlugin editorId={editorId} readOnly={readOnly} />
        <TriggerPlugin
          onLinkSelect={handlePillClick}
          onAddClass={onAddClass}
          onSlashCommand={onSlashCommand}
        />
        <PasteImagePlugin onPasteImage={onPasteImage} />
        <FloatingToolbarPlugin />
        <ContextMenuPlugin
          onNavigateToNode={onNavigateToNode}
          onOpenInSidebar={onOpenInSidebar}
        />
        <BlurOnClickOutsidePlugin readOnly={readOnly} />
      </LexicalComposer>
    </div>
  );
});
