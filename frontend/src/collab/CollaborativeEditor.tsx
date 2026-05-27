/**
 * CollaborativeEditor — Beta collaborative editing using Yjs + Lexical.
 *
 * Uses @lexical/yjs CollaborationPluginV2 for real-time sync.
 * This is a simplified editor that uses standard Lexical nodes
 * (paragraph, heading, text) instead of custom BlockNodes.
 *
 * Phase 3: Beta. Supports basic rich-text collaboration.
 */

import { useEffect, useMemo } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { CollaborationPluginV2__EXPERIMENTAL } from '@lexical/react/LexicalCollaborationPlugin';
import * as Y from 'yjs';

import { FastAPIProvider } from './FastAPIProvider';
import { getAuthToken } from '@/utils/auth';

import './CollaborativeEditor.css';

interface CollaborativeEditorProps {
  pageUuid: string;
}

const editorConfig = {
  namespace: 'NoteesCollaborative',
  theme: {
    paragraph: 'collab-paragraph',
    heading: {
      h1: 'collab-heading-h1',
      h2: 'collab-heading-h2',
      h3: 'collab-heading-h3',
    },
    text: {
      bold: 'collab-text-bold',
      italic: 'collab-text-italic',
      underline: 'collab-text-underline',
      strikethrough: 'collab-text-strikethrough',
      code: 'collab-text-code',
    },
  },
  onError(error: Error) {
    console.error('CollaborativeEditor error:', error);
  },
  nodes: [],
};

export function CollaborativeEditor({ pageUuid }: CollaborativeEditorProps) {
  const token = getAuthToken();


  const { ydoc, provider } = useMemo(() => {
    if (!token) return { ydoc: null, provider: null };
    const doc = new Y.Doc();
    const prov = new FastAPIProvider(pageUuid, token, doc);
    return { ydoc: doc, provider: prov };
  }, [pageUuid, token]);

  useEffect(() => {
    return () => {
      provider?.disconnect();
    };
  }, [provider]);

  if (!ydoc || !provider) {
    return <div className="collab-editor-unauthenticated">Authentication required for collaboration</div>;
  }

  return (
    <div className="collaborative-editor">
      <LexicalComposer initialConfig={editorConfig}>
        <RichTextPlugin
          contentEditable={<ContentEditable className="collab-content-editable" />}
          placeholder={<div className="collab-placeholder">Start typing collaboratively...</div>}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <CollaborationPluginV2__EXPERIMENTAL
          id={pageUuid}
          doc={ydoc}
          provider={provider}
          username="User"
          cursorColor="#2563eb"
        />
      </LexicalComposer>
    </div>
  );
}
