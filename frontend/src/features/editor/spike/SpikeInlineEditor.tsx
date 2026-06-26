/**
 * SpikeInlineEditor — minimal Lexical editor wired to a shared Yjs doc.
 *
 * This is a throwaway component for the M4 CRDT spike. It intentionally
 * duplicates just enough of `InlineEditor` to host the collaboration plugin
 * without touching production code paths.
 */

import { useEffect, useMemo, type JSX } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { CollaborationPluginV2__EXPERIMENTAL } from '@lexical/react/LexicalCollaborationPlugin';
import { LexicalCollaboration } from '@lexical/react/LexicalCollaborationContext';
import {
  ParagraphNode,
  TextNode,
  type LexicalEditor,
} from 'lexical';
import type { EditorState } from 'lexical';
import type { Doc } from 'yjs';
import {
  InlineLinkNode,
  InlineDateRangeNode,
  MathNode,
  notesEditorTheme,
} from '@/features/editor';
import type { InMemoryProvider } from './inMemoryProvider';
import type { ContentAST } from '@/runtime/types';

interface SpikeInlineEditorProps {
  id: string;
  doc: Doc;
  provider: InMemoryProvider;
  username: string;
  cursorColor: string;
  placeholder?: string;
  onEditorReady?: (editor: LexicalEditor) => void;
  onChange?: (ast: ContentAST) => void;
}

function EditorReadyBridge({
  onEditorReady,
}: {
  onEditorReady?: (editor: LexicalEditor) => void;
}): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    onEditorReady?.(editor);
  }, [editor, onEditorReady]);
  return null;
}

export function SpikeInlineEditor({
  id,
  doc,
  provider,
  username,
  cursorColor,
  placeholder,
  onEditorReady,
  onChange,
}: SpikeInlineEditorProps): JSX.Element {
  const initialConfig = useMemo(
    () => ({
      namespace: `SpikeInlineEditor-${id}`,
      theme: notesEditorTheme,
      nodes: [ParagraphNode, TextNode, InlineLinkNode, InlineDateRangeNode, MathNode],
      onError: (error: Error) => {
        console.error(`[SpikeInlineEditor ${id}]`, error);
      },
      editable: true,
    }),
    [id],
  );

  const handleChange = (editorState: EditorState): void => {
    editorState.read(() => {
      // Intentionally empty: we only need a change signal.
    });
    onChange?.([]);
  };

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <LexicalCollaboration>
        <div className="spike-inline-editor" data-editor-id={id}>
          <RichTextPlugin
            contentEditable={<ContentEditable className="spike-inline-editor__content" aria-label="Spike editor" />}
            placeholder={placeholder ? <div className="spike-inline-editor__placeholder">{placeholder}</div> : null}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <CollaborationPluginV2__EXPERIMENTAL
            id={id}
            doc={doc}
            provider={provider}
            username={username}
            cursorColor={cursorColor}
            __shouldBootstrapUnsafe
          />
          <OnChangePlugin onChange={handleChange} ignoreHistoryMergeTagChange />
          <EditorReadyBridge onEditorReady={onEditorReady} />
        </div>
      </LexicalCollaboration>
    </LexicalComposer>
  );
}
