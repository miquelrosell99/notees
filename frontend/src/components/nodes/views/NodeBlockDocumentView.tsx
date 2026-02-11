/**
 * NodeBlockDocumentView — Document view using Lexical editor.
 *
 * Flat list ignoring depth — renders as a continuous document.
 */

import { type JSX } from 'react';
import { NoteesEditor } from '../../editor/NoteesEditor';

export interface NodeBlockDocumentViewProps {
  rootBlockId: string;
  editorId?: string;
  readOnly?: boolean;
  onNavigateToNode?: (linkId: string) => void;
  onEscape?: () => void;
  className?: string;
}

export function NodeBlockDocumentView({
  rootBlockId,
  editorId,
  readOnly = false,
  onNavigateToNode,
  onEscape,
  className,
}: NodeBlockDocumentViewProps): JSX.Element {
  return (
    <div className={`node-block-document-view ${className || ''}`}>
      <NoteesEditor
        editorId={editorId || `doc-${rootBlockId}`}
        rootBlockId={rootBlockId}
        viewMode="document"
        readOnly={readOnly}
        onNavigateToNode={onNavigateToNode}
        onEscape={onEscape}
        placeholder="Start writing…"
      />
    </div>
  );
}
